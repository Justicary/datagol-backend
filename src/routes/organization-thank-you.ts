import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
    requireAuthenticatedUser,
    requireOrganizationMembership,
    requireOrganizationRole,
} from '../lib/organization-auth.js';
import {
    orgIdParamSchema,
    orgSendParamSchema,
    organizationThankYouUpdateSchema,
    thankYouTestBodySchema,
    thankYouLogQuerySchema,
    thankYouResendBodySchema,
} from '../schemas/thank-you.js';
import { getActiveOrganizationAttachment, generateAttachmentSignedUrl, downloadAttachmentBuffer } from '../services/attachment-service.js';
import { sendThankYouEmail } from '../services/email.js';
import { sendThankYouWhatsApp } from '../services/thank-you-whatsapp.js';
import { THANK_YOU_CHANNELS, THANK_YOU_STATUSES, type OrganizationThankYouSettings } from '../types/thank-you.js';

// Control de tasa en memoria para envíos de prueba de agradecimiento: 5 envíos por cada 15 min
const TEST_THANK_YOU_RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_TEST_THANK_YOU_PER_WINDOW = 5;
const testThankYouTimestamps = new Map<string, number[]>();

export function checkAndIncrementThankYouRateLimit(organizationId: string): boolean {
    const now = Date.now();
    const timestamps = testThankYouTimestamps.get(organizationId) || [];
    const recent = timestamps.filter((t) => now - t < TEST_THANK_YOU_RATE_WINDOW_MS);

    if (recent.length >= MAX_TEST_THANK_YOU_PER_WINDOW) {
        return false;
    }

    recent.push(now);
    testThankYouTimestamps.set(organizationId, recent);
    return true;
}

export function clearThankYouRateLimits(): void {
    testThankYouTimestamps.clear();
}

/**
 * Rutas de configuración, pruebas y logs para Agradecimiento Automático Omnicanal.
 */
export async function organizationThankYouRoutes(fastify: FastifyInstance) {
    /**
     * Helper de autorización para miembros con roles administrativos.
     */
    async function authorizeAdmin(
        request: FastifyRequest<{ Params: { id: string } }>,
        reply: FastifyReply
    ): Promise<{ userId: string; jwt: string; organizationId: string; userEmail?: string } | null> {
        const paramsResult = orgIdParamSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
            return null;
        }
        const { id: organizationId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const isMember = await requireOrganizationMembership(fastify, auth.jwt, organizationId);
        if (!isMember) {
            reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
            return null;
        }

        const isAuthorizedRole = await requireOrganizationRole(fastify, auth.jwt, organizationId, auth.userId, ['owner', 'admin']);
        if (!isAuthorizedRole) {
            reply.status(403).send({ success: false, error: 'Se requiere rol admin u owner para gestionar el agradecimiento.' });
            return null;
        }

        return { userId: auth.userId, jwt: auth.jwt, organizationId, userEmail: (request as any).user?.email };
    }

    /**
     * Helper de autorización para cualquier miembro de la organización.
     */
    async function authorizeMember(
        request: FastifyRequest<{ Params: { id: string } }>,
        reply: FastifyReply
    ): Promise<{ userId: string; jwt: string; organizationId: string } | null> {
        const paramsResult = orgIdParamSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
            return null;
        }
        const { id: organizationId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const isMember = await requireOrganizationMembership(fastify, auth.jwt, organizationId);
        if (!isMember) {
            reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
            return null;
        }

        return { userId: auth.userId, jwt: auth.jwt, organizationId };
    }

    /**
     * GET /api/organizations/:id/thank-you
     * Obtiene la configuración actual de agradecimiento y el adjunto activo.
     */
    fastify.get('/api/organizations/:id/thank-you', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const ctx = await authorizeMember(request, reply);
        if (!ctx) return;

        const { data: org, error } = await fastify.supabaseAdmin
            .from('organizations')
            .select('name, integration_settings')
            .eq('id', ctx.organizationId)
            .single();

        if (error || !org) {
            return reply.status(500).send({ success: false, error: 'No se pudo consultar la organización.' });
        }

        const settings = (org.integration_settings as Record<string, any>) || {};
        const thankYouConfig: OrganizationThankYouSettings = {
            enabled: false,
            dedupeWindowDays: 30,
            emailSubject: null,
            emailBody: null,
            whatsappTemplateName: null,
            attachmentId: null,
            ...(settings.thankYou || {}),
        };

        const activeAttachment = await getActiveOrganizationAttachment(fastify, ctx.organizationId);

        return reply.send({
            success: true,
            data: {
                ...thankYouConfig,
                activeAttachment: activeAttachment
                    ? {
                          id: activeAttachment.id,
                          fileName: activeAttachment.file_name,
                          mimeType: activeAttachment.mime_type,
                          sizeBytes: activeAttachment.size_bytes,
                          createdAt: activeAttachment.created_at,
                      }
                    : null,
            },
        });
    });

    /**
     * PATCH /api/organizations/:id/thank-you
     * Actualiza la configuración de agradecimiento automático.
     */
    fastify.patch('/api/organizations/:id/thank-you', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const ctx = await authorizeAdmin(request, reply);
        if (!ctx) return;

        const parseResult = organizationThankYouUpdateSchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'Cuerpo de la petición inválido.',
                details: parseResult.error.format(),
            });
        }

        const { data: org, error: fetchErr } = await fastify.supabaseAdmin
            .from('organizations')
            .select('integration_settings')
            .eq('id', ctx.organizationId)
            .single();

        if (fetchErr || !org) {
            return reply.status(500).send({ success: false, error: 'No se pudo consultar la configuración actual.' });
        }

        const currentSettings = (org.integration_settings as Record<string, any>) || {};
        const currentThankYou = currentSettings.thankYou || {
            enabled: false,
            dedupeWindowDays: 30,
            emailSubject: null,
            emailBody: null,
            whatsappTemplateName: null,
            attachmentId: null,
        };

        const updatedThankYou: OrganizationThankYouSettings = {
            ...currentThankYou,
            ...parseResult.data,
        };

        const { error: updateErr } = await fastify.supabaseAdmin
            .from('organizations')
            .update({
                integration_settings: {
                    ...currentSettings,
                    thankYou: updatedThankYou,
                },
            })
            .eq('id', ctx.organizationId);

        if (updateErr) {
            request.log.error({ updateErr, organizationId: ctx.organizationId }, 'Error al actualizar thankYou settings');
            return reply.status(500).send({ success: false, error: 'No se pudo guardar la configuración.' });
        }

        return reply.send({
            success: true,
            data: updatedThankYou,
        });
    });

    /**
     * POST /api/organizations/:id/thank-you/test
     * Envía un agradecimiento de prueba al correo o teléfono indicado (o del admin).
     */
    fastify.post('/api/organizations/:id/thank-you/test', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const ctx = await authorizeAdmin(request, reply);
        if (!ctx) return;

        const bodyResult = thankYouTestBodySchema.safeParse(request.body || {});
        if (!bodyResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'Cuerpo de prueba inválido.',
                details: bodyResult.error.format(),
            });
        }

        if (!checkAndIncrementThankYouRateLimit(ctx.organizationId)) {
            return reply.status(429).send({
                success: false,
                error: 'Límite de envíos de prueba alcanzado. Máximo 5 pruebas cada 15 minutos.',
            });
        }

        const { channel, to } = bodyResult.data;

        const { data: org } = await fastify.supabaseAdmin
            .from('organizations')
            .select('name, phone_number, integration_settings')
            .eq('id', ctx.organizationId)
            .single();

        const orgName = org?.name || 'Datagol AI';
        const settings = (org?.integration_settings as Record<string, any>) || {};
        const thankYouConfig = settings.thankYou || {};

        const activeAttachment = await getActiveOrganizationAttachment(fastify, ctx.organizationId);
        let signedUrl: string | null = null;
        if (activeAttachment) {
            signedUrl = await generateAttachmentSignedUrl(fastify, activeAttachment.storage_path, 3600 * 24);
        }

        if (channel === THANK_YOU_CHANNELS.EMAIL) {
            const recipientEmail = to || ctx.userEmail || (request as any).user?.email;
            if (!recipientEmail) {
                return reply.status(400).send({
                    success: false,
                    error: 'Debes proporcionar una dirección de correo para la prueba.',
                });
            }

            let fileBuffer: Buffer | null = null;
            if (activeAttachment) {
                fileBuffer = await downloadAttachmentBuffer(fastify, activeAttachment.storage_path);
            }

            const sendRes = await sendThankYouEmail({
                organizationId: ctx.organizationId,
                to: recipientEmail,
                prospectName: 'Usuario de Prueba (Admin)',
                businessName: orgName,
                customSubject: thankYouConfig.emailSubject ? `[PRUEBA] ${thankYouConfig.emailSubject}` : `[PRUEBA] ¡Gracias por contactar a ${orgName}!`,
                customBody: thankYouConfig.emailBody,
                attachmentBuffer: fileBuffer,
                attachmentFileName: activeAttachment?.file_name,
                attachmentDownloadUrl: signedUrl,
            });

            if (!sendRes) {
                return reply.status(500).send({
                    success: false,
                    error: 'No se pudo enviar el correo de prueba. Verifica la configuración de Resend.',
                });
            }

            return reply.send({
                success: true,
                message: `Correo de agradecimiento de prueba enviado a ${recipientEmail}`,
                data: {
                    channel: 'email',
                    recipient: recipientEmail,
                },
            });
        } else {
            // Canal WhatsApp
            const recipientPhone = to || org?.phone_number;
            if (!recipientPhone) {
                return reply.status(400).send({
                    success: false,
                    error: 'Debes proporcionar un número de teléfono en formato E.164 para la prueba de WhatsApp.',
                });
            }

            // Para la prueba de WhatsApp, mockeamos contactId como 'test-admin'
            const waResult = await sendThankYouWhatsApp(fastify, {
                organizationId: ctx.organizationId,
                contactId: '00000000-0000-0000-0000-000000000000',
                phoneE164: recipientPhone,
                prospectName: 'Usuario de Prueba',
                businessName: orgName,
                customBody: thankYouConfig.emailBody,
                whatsappTemplateName: thankYouConfig.whatsappTemplateName,
                attachmentDownloadUrl: signedUrl,
            });

            if (!waResult.sent) {
                return reply.status(400).send({
                    success: false,
                    error: `No se pudo enviar el WhatsApp de prueba: ${waResult.skipReason || waResult.error}`,
                });
            }

            return reply.send({
                success: true,
                message: `Mensaje de prueba de WhatsApp enviado a ${recipientPhone}`,
                data: {
                    channel: 'whatsapp',
                    recipient: recipientPhone,
                    waMessageId: waResult.waMessageId,
                },
            });
        }
    });

    /**
     * GET /api/organizations/:id/thank-you/log
     * Consulta el historial paginado de envíos y omisiones de agradecimiento.
     */
    fastify.get('/api/organizations/:id/thank-you/log', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const ctx = await authorizeMember(request, reply);
        if (!ctx) return;

        const queryResult = thankYouLogQuerySchema.safeParse(request.query || {});
        if (!queryResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'Parámetros de consulta inválidos.',
                details: queryResult.error.format(),
            });
        }

        const { page, limit, status, channel } = queryResult.data;
        const offset = (page - 1) * limit;

        let query = fastify.supabaseAdmin
            .from('thank_you_sends')
            .select(
                `id, organization_id, contact_id, lead_id, channel, status, skip_reason, sent_at, created_at,
                 contacts(id, full_name, email, phone_e164),
                 organization_attachments(file_name, size_bytes)`,
                { count: 'exact' }
            )
            .eq('organization_id', ctx.organizationId);

        if (status) {
            query = query.eq('status', status);
        }
        if (channel) {
            query = query.eq('channel', channel);
        }

        const { data, count, error } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            request.log.error({ error, organizationId: ctx.organizationId }, 'Error al consultar logs de agradecimiento');
            return reply.status(500).send({ success: false, error: 'No se pudo consultar el historial.' });
        }

        const total = count ?? 0;
        const totalPages = Math.ceil(total / limit);

        return reply.send({
            success: true,
            data: data || [],
            pagination: {
                page,
                limit,
                total,
                totalPages,
            },
        });
    });

    /**
     * DELETE /api/organizations/:id/thank-you/log/:sendId
     * Elimina discrecionalmente un registro de omisión o fallo del historial.
     * REGLA ESTRICTA: Únicamente registros con estado 'omitido' o 'fallido' pueden eliminarse.
     */
    fastify.delete('/api/organizations/:id/thank-you/log/:sendId', async (request: FastifyRequest<{ Params: { id: string; sendId: string } }>, reply) => {
        const paramsResult = orgSendParamSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'Parámetros de ruta inválidos.',
                details: paramsResult.error.format(),
            });
        }

        const ctx = await authorizeAdmin(request as any, reply);
        if (!ctx) return;

        const { sendId } = paramsResult.data;

        const { data: record, error: fetchError } = await fastify.supabaseAdmin
            .from('thank_you_sends')
            .select('id, status')
            .eq('id', sendId)
            .eq('organization_id', ctx.organizationId)
            .maybeSingle();

        if (fetchError) {
            request.log.error({ fetchError, organizationId: ctx.organizationId, sendId }, 'Error al consultar registro de agradecimiento para eliminación');
            return reply.status(500).send({ success: false, error: 'No se pudo consultar el registro de auditoría.' });
        }

        if (!record) {
            return reply.status(404).send({ success: false, error: 'Registro de auditoría no encontrado.' });
        }

        if (record.status !== THANK_YOU_STATUSES.OMITIDO && record.status !== THANK_YOU_STATUSES.FALLIDO) {
            return reply.status(400).send({
                success: false,
                error: 'Solo se pueden eliminar registros con estado "omitido" o "fallido".',
            });
        }

        const { error: deleteError } = await fastify.supabaseAdmin
            .from('thank_you_sends')
            .delete()
            .eq('id', sendId)
            .eq('organization_id', ctx.organizationId);

        if (deleteError) {
            request.log.error({ deleteError, organizationId: ctx.organizationId, sendId }, 'Error al eliminar registro de auditoría');
            return reply.status(500).send({ success: false, error: 'No se pudo eliminar el registro de auditoría.' });
        }

        return reply.send({
            success: true,
            message: 'Registro de auditoría eliminado exitosamente.',
        });
    });

    /**
     * POST /api/organizations/:id/thank-you/resend
     * Reenvío discrecional del correo de bienvenida y su adjunto, omitiendo la ventana de deduplicación.
     */
    fastify.post('/api/organizations/:id/thank-you/resend', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const ctx = await authorizeAdmin(request as any, reply);
        if (!ctx) return;

        const bodyResult = thankYouResendBodySchema.safeParse(request.body || {});
        if (!bodyResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'Cuerpo de la petición inválido.',
                details: bodyResult.error.format(),
            });
        }

        const { sendId, contactId, email: directEmail } = bodyResult.data;

        let targetEmail: string | null = null;
        let targetContactId: string | null = null;
        let prospectName = 'Estimado cliente';

        if (sendId) {
            const { data: sendRow, error: sendErr } = await fastify.supabaseAdmin
                .from('thank_you_sends')
                .select('id, contact_id, channel, status, contacts(id, email, full_name, phone_e164)')
                .eq('id', sendId)
                .eq('organization_id', ctx.organizationId)
                .maybeSingle();

            if (sendErr) {
                request.log.error({ sendErr, organizationId: ctx.organizationId, sendId }, 'Error al consultar thank_you_sends para reenvío');
                return reply.status(500).send({ success: false, error: 'No se pudo consultar el registro de auditoría.' });
            }

            if (!sendRow) {
                return reply.status(404).send({ success: false, error: 'Registro de auditoría no encontrado.' });
            }

            const contactData = Array.isArray(sendRow.contacts) ? sendRow.contacts[0] : sendRow.contacts;
            targetContactId = sendRow.contact_id || contactData?.id || null;
            targetEmail = directEmail || contactData?.email || null;
            if (contactData?.full_name) {
                prospectName = contactData.full_name;
            }
        } else if (contactId) {
            const { data: contactRow, error: contactErr } = await fastify.supabaseAdmin
                .from('contacts')
                .select('id, email, full_name')
                .eq('id', contactId)
                .eq('organization_id', ctx.organizationId)
                .maybeSingle();

            if (contactErr) {
                request.log.error({ contactErr, organizationId: ctx.organizationId, contactId }, 'Error al consultar contacto para reenvío');
                return reply.status(500).send({ success: false, error: 'No se pudo consultar el contacto.' });
            }

            if (!contactRow) {
                return reply.status(404).send({ success: false, error: 'Contacto no encontrado en esta organización.' });
            }

            targetContactId = contactRow.id;
            targetEmail = directEmail || contactRow.email || null;
            if (contactRow.full_name) {
                prospectName = contactRow.full_name;
            }
        } else if (directEmail) {
            targetEmail = directEmail;
            const { data: contactByEmail } = await fastify.supabaseAdmin
                .from('contacts')
                .select('id, email, full_name')
                .eq('email', directEmail.trim())
                .eq('organization_id', ctx.organizationId)
                .maybeSingle();

            if (contactByEmail) {
                targetContactId = contactByEmail.id;
                if (contactByEmail.full_name) {
                    prospectName = contactByEmail.full_name;
                }
            } else {
                // Crear contacto para asociar la auditoría
                const { data: createdContact } = await fastify.supabaseAdmin
                    .from('contacts')
                    .insert({
                        organization_id: ctx.organizationId,
                        email: directEmail.trim(),
                        full_name: 'Prospecto',
                    })
                    .select('id')
                    .single();

                targetContactId = createdContact?.id || null;
            }
        }

        if (!targetEmail) {
            return reply.status(400).send({
                success: false,
                error: 'No se encontró una dirección de correo electrónico válida para el reenvío.',
            });
        }

        // Obtener configuración de organización y adjuntos
        const { data: org } = await fastify.supabaseAdmin
            .from('organizations')
            .select('name, integration_settings')
            .eq('id', ctx.organizationId)
            .single();

        const orgName = org?.name || 'Datagol AI';
        const settings = (org?.integration_settings as Record<string, any>) || {};
        const thankYouConfig = settings.thankYou || {};

        const activeAttachment = await getActiveOrganizationAttachment(fastify, ctx.organizationId);
        let signedUrl: string | null = null;
        let fileBuffer: Buffer | null = null;

        if (activeAttachment) {
            signedUrl = await generateAttachmentSignedUrl(fastify, activeAttachment.storage_path, 3600 * 24);
            fileBuffer = await downloadAttachmentBuffer(fastify, activeAttachment.storage_path);
        }

        const sendRes = await sendThankYouEmail({
            organizationId: ctx.organizationId,
            to: targetEmail,
            prospectName,
            businessName: orgName,
            customSubject: thankYouConfig.emailSubject,
            customBody: thankYouConfig.emailBody,
            attachmentBuffer: fileBuffer,
            attachmentFileName: activeAttachment?.file_name,
            attachmentDownloadUrl: signedUrl,
        });

        if (!sendRes) {
            if (sendId) {
                await fastify.supabaseAdmin
                    .from('thank_you_sends')
                    .update({
                        status: THANK_YOU_STATUSES.FALLIDO,
                        skip_reason: 'Fallo al reenviar correo de agradecimiento vía Resend',
                    })
                    .eq('id', sendId);
            }
            return reply.status(500).send({
                success: false,
                error: 'No se pudo enviar el correo de agradecimiento vía Resend.',
            });
        }

        const sentTimestamp = new Date().toISOString();

        if (sendId) {
            await fastify.supabaseAdmin
                .from('thank_you_sends')
                .update({
                    status: THANK_YOU_STATUSES.ENVIADO,
                    sent_at: sentTimestamp,
                    skip_reason: null,
                    attachment_id: activeAttachment?.id ?? null,
                })
                .eq('id', sendId);

            return reply.send({
                success: true,
                message: `Correo de agradecimiento reenviado exitosamente a ${targetEmail}`,
                data: {
                    sendId,
                    channel: 'email',
                    recipient: targetEmail,
                    sentAt: sentTimestamp,
                },
            });
        } else {
            const { data: newSendRecord } = await fastify.supabaseAdmin
                .from('thank_you_sends')
                .insert({
                    organization_id: ctx.organizationId,
                    contact_id: targetContactId,
                    channel: THANK_YOU_CHANNELS.EMAIL,
                    status: THANK_YOU_STATUSES.ENVIADO,
                    sent_at: sentTimestamp,
                    attachment_id: activeAttachment?.id ?? null,
                    skip_reason: null,
                })
                .select('id, sent_at')
                .single();

            return reply.send({
                success: true,
                message: `Correo de agradecimiento enviado exitosamente a ${targetEmail}`,
                data: {
                    sendId: newSendRecord?.id,
                    channel: 'email',
                    recipient: targetEmail,
                    sentAt: newSendRecord?.sent_at || sentTimestamp,
                },
            });
        }
    });
}

export default organizationThankYouRoutes;
