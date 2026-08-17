import { FastifyInstance } from 'fastify';
import { getOrganizationFeatures } from './entitlements.js';
import {
    getActiveOrganizationAttachment,
    getOrganizationAttachmentById,
    generateAttachmentSignedUrl,
    downloadAttachmentBuffer,
} from './attachment-service.js';
import { sendThankYouEmail } from './email.js';
import { sendThankYouWhatsApp } from './thank-you-whatsapp.js';
import {
    THANK_YOU_CHANNELS,
    THANK_YOU_STATUSES,
    THANK_YOU_SKIP_REASONS,
    type ThankYouChannel,
    type OrganizationThankYouSettings,
} from '../types/thank-you.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { LEAD_CHANNELS } from '../types/lead-enums.js';

interface LeadResolutionRow {
    id: string;
    organization_id: string;
    contact_id: string | null;
    channel: string | null;
    full_name: string | null;
    email: string | null;
    contact_phone: string | null;
    business_name: string | null;
    contacts: {
        id: string;
        email: string | null;
        phone_e164: string | null;
        full_name: string | null;
        opted_out: boolean;
    } | null;
    organizations: {
        id: string;
        name: string;
        integration_settings: Record<string, unknown> | null;
    } | null;
}

/**
 * Matriz pura de decisión de canal según las especificaciones de la tarea.
 */
export function resolveThankYouChannel(params: {
    hasActiveAttachment: boolean;
    hasEmail: boolean;
    hasPhone: boolean;
    originChannel?: string | null;
    isWhatsAppEntitled?: boolean;
}): ThankYouChannel | null {
    const { hasActiveAttachment, hasEmail, hasPhone, originChannel, isWhatsAppEntitled = true } = params;

    // 1. Hay adjunto configurado y hay correo -> Correo (único canal que lleva archivo)
    if (hasActiveAttachment && hasEmail) {
        return THANK_YOU_CHANNELS.EMAIL;
    }

    // 2. No hay adjunto, el prospecto llegó por WhatsApp -> WhatsApp
    if (!hasActiveAttachment && originChannel === LEAD_CHANNELS.WHATSAPP && hasPhone && isWhatsAppEntitled) {
        return THANK_YOU_CHANNELS.WHATSAPP;
    }

    // 3. No hay adjunto, llegó por voz o web, y hay correo -> Correo
    if (!hasActiveAttachment && hasEmail) {
        return THANK_YOU_CHANNELS.EMAIL;
    }

    // 4. Solo hay teléfono, sin correo -> WhatsApp si está disponible
    if (!hasEmail && hasPhone) {
        return isWhatsAppEntitled ? THANK_YOU_CHANNELS.WHATSAPP : null;
    }

    // 5. Hay ambos y ninguna condición anterior aplica -> Correo
    if (hasEmail) {
        return THANK_YOU_CHANNELS.EMAIL;
    }

    return null;
}

/**
 * Procesa el agradecimiento automático para un lead captado.
 * Orquesta elegibilidad, deduplicación atómica, resolución de canal y despacho.
 */
export async function processThankYouForLead(fastify: FastifyInstance, leadId: string): Promise<void> {
    // 1. Cargar lead con contacto y organización
    const { data: lead, error: fetchError } = await fastify.supabaseAdmin
        .from('leads')
        .select(
            `id, organization_id, contact_id, channel, full_name, email, contact_phone, business_name,
             contacts(id, email, phone_e164, full_name, opted_out),
             organizations(id, name, integration_settings)`
        )
        .eq('id', leadId)
        .single<LeadResolutionRow>();

    if (fetchError || !lead) {
        throw new Error(`No se encontró leads.id=${leadId}: ${fetchError?.message ?? 'sin datos'}`);
    }

    const organizationId = lead.organization_id;
    const orgSettings = (lead.organizations?.integration_settings as Record<string, any>) || {};
    const thankYouSettings = (orgSettings.thankYou as OrganizationThankYouSettings | undefined) || {
        enabled: false,
        dedupeWindowDays: 30,
    };

    const contactId = lead.contact_id || lead.contacts?.id;
    if (!contactId) {
        fastify.log.info({ leadId, organizationId }, '[ThankYou] Lead sin contact_id asociado; no se puede deduplicar ni enviar');
        return;
    }

    // 2. Verificar opt-out
    if (lead.contacts?.opted_out === true) {
        fastify.log.info({ leadId, contactId }, '[ThankYou] Contacto está opted_out; se omite envío');
        await fastify.supabaseAdmin.from('thank_you_sends').insert({
            organization_id: organizationId,
            contact_id: contactId,
            lead_id: leadId,
            channel: THANK_YOU_CHANNELS.EMAIL,
            status: THANK_YOU_STATUSES.OMITIDO,
            skip_reason: THANK_YOU_SKIP_REASONS.OPTED_OUT,
        });
        return;
    }

    // 3. Resolver datos de contacto
    const resolvedEmail = lead.email || lead.contacts?.email || null;
    const resolvedPhone = lead.contacts?.phone_e164 || lead.contact_phone || null;

    if (!resolvedEmail && !resolvedPhone) {
        fastify.log.info({ leadId, contactId }, '[ThankYou] Prospecto no dejó ni correo ni teléfono; se omite');
        await fastify.supabaseAdmin.from('thank_you_sends').insert({
            organization_id: organizationId,
            contact_id: contactId,
            lead_id: leadId,
            channel: THANK_YOU_CHANNELS.EMAIL,
            status: THANK_YOU_STATUSES.OMITIDO,
            skip_reason: THANK_YOU_SKIP_REASONS.NO_CONTACT_INFO,
        });
        return;
    }

    // 4. Verificar entitlement de la feature
    const enabledFeatures = await getOrganizationFeatures(organizationId);
    if (!enabledFeatures.has(FEATURE_KEYS.AUTOMATIC_THANK_YOU)) {
        fastify.log.info({ organizationId, leadId }, '[ThankYou] Feature automatic_thank_you no concedida para este tenant; se omite');
        await fastify.supabaseAdmin.from('thank_you_sends').insert({
            organization_id: organizationId,
            contact_id: contactId,
            lead_id: leadId,
            channel: THANK_YOU_CHANNELS.EMAIL,
            status: THANK_YOU_STATUSES.OMITIDO,
            skip_reason: THANK_YOU_SKIP_REASONS.FEATURE_DISABLED,
        });
        return;
    }

    // 5. Verificar si el agradecimiento está habilitado en la organización
    if (!thankYouSettings.enabled) {
        fastify.log.info({ organizationId, leadId }, '[ThankYou] Agradecimiento desactivado en integration_settings.thankYou; se omite');
        await fastify.supabaseAdmin.from('thank_you_sends').insert({
            organization_id: organizationId,
            contact_id: contactId,
            lead_id: leadId,
            channel: THANK_YOU_CHANNELS.EMAIL,
            status: THANK_YOU_STATUSES.OMITIDO,
            skip_reason: THANK_YOU_SKIP_REASONS.SETTINGS_DISABLED,
        });
        return;
    }

    // 6. Obtener adjunto configurado/activo
    let activeAttachment = null;
    if (thankYouSettings.attachmentId) {
        activeAttachment = await getOrganizationAttachmentById(fastify, organizationId, thankYouSettings.attachmentId);
    }
    if (!activeAttachment) {
        activeAttachment = await getActiveOrganizationAttachment(fastify, organizationId);
    }

    // 7. Resolver canal
    const resolvedChannel = resolveThankYouChannel({
        hasActiveAttachment: !!activeAttachment,
        hasEmail: !!resolvedEmail,
        hasPhone: !!resolvedPhone,
        originChannel: lead.channel,
        isWhatsAppEntitled: enabledFeatures.has(FEATURE_KEYS.WHATSAPP),
    });

    if (!resolvedChannel) {
        fastify.log.info({ organizationId, leadId }, '[ThankYou] No hay canal disponible para el envío; se omite');
        await fastify.supabaseAdmin.from('thank_you_sends').insert({
            organization_id: organizationId,
            contact_id: contactId,
            lead_id: leadId,
            channel: THANK_YOU_CHANNELS.EMAIL,
            status: THANK_YOU_STATUSES.OMITIDO,
            skip_reason: 'sin_canal_disponible',
        });
        return;
    }

    // 8. Deduplicación atómica vía RPC en Postgres
    const dedupeWindowDays = thankYouSettings.dedupeWindowDays || 30;
    const { data: attemptResult, error: rpcError } = await fastify.supabaseAdmin.rpc('register_thank_you_attempt', {
        p_organization_id: organizationId,
        p_contact_id: contactId,
        p_lead_id: leadId,
        p_channel: resolvedChannel,
        p_attachment_id: activeAttachment?.id ?? null,
        p_dedupe_window_days: dedupeWindowDays,
    });

    if (rpcError || !attemptResult) {
        fastify.log.error({ rpcError, organizationId, contactId }, '[ThankYou] Error en RPC register_thank_you_attempt');
        throw new Error(`Falló register_thank_you_attempt: ${rpcError?.message ?? 'sin datos'}`);
    }

    const { allowed, send_id: sendId, skip_reason: rpcSkipReason } = attemptResult as {
        allowed: boolean;
        send_id: string;
        skip_reason: string | null;
    };

    if (!allowed) {
        fastify.log.info({ contactId, organizationId, rpcSkipReason }, '[ThankYou] Enlace de deduplicación: omitido por ventana móvil');
        return;
    }

    // 9. Despachar envío según canal
    const prospectName = lead.full_name || lead.contacts?.full_name || 'Estimado cliente';
    const businessName = lead.business_name || lead.organizations?.name || 'nuestro equipo';

    let signedUrl: string | null = null;
    if (activeAttachment) {
        signedUrl = await generateAttachmentSignedUrl(fastify, activeAttachment.storage_path, 3600 * 24);
    }

    try {
        if (resolvedChannel === THANK_YOU_CHANNELS.EMAIL) {
            let fileBuffer: Buffer | null = null;
            if (activeAttachment) {
                fileBuffer = await downloadAttachmentBuffer(fastify, activeAttachment.storage_path);
            }

            const response = await sendThankYouEmail({
                organizationId,
                to: resolvedEmail!,
                prospectName,
                businessName,
                customSubject: thankYouSettings.emailSubject,
                customBody: thankYouSettings.emailBody,
                attachmentBuffer: fileBuffer,
                attachmentFileName: activeAttachment?.file_name,
                attachmentDownloadUrl: signedUrl,
            });

            if (!response) {
                throw new Error('Resend no pudo entregar el correo de agradecimiento.');
            }

            await fastify.supabaseAdmin
                .from('thank_you_sends')
                .update({
                    status: THANK_YOU_STATUSES.ENVIADO,
                    sent_at: new Date().toISOString(),
                })
                .eq('id', sendId);

            fastify.log.info({ leadId, sendId, channel: 'email' }, '[ThankYou] Agradecimiento por correo enviado exitosamente');
        } else {
            // Canal WhatsApp
            const waResult = await sendThankYouWhatsApp(fastify, {
                organizationId,
                contactId,
                phoneE164: resolvedPhone!,
                prospectName,
                businessName,
                customBody: thankYouSettings.emailBody,
                whatsappTemplateName: thankYouSettings.whatsappTemplateName,
                attachmentDownloadUrl: signedUrl,
            });

            if (waResult.sent) {
                await fastify.supabaseAdmin
                    .from('thank_you_sends')
                    .update({
                        status: THANK_YOU_STATUSES.ENVIADO,
                        sent_at: new Date().toISOString(),
                    })
                    .eq('id', sendId);

                fastify.log.info({ leadId, sendId, channel: 'whatsapp' }, '[ThankYou] Agradecimiento por WhatsApp enviado exitosamente');
            } else if (waResult.skipReason) {
                await fastify.supabaseAdmin
                    .from('thank_you_sends')
                    .update({
                        status: THANK_YOU_STATUSES.OMITIDO,
                        skip_reason: waResult.skipReason,
                    })
                    .eq('id', sendId);

                fastify.log.info({ leadId, sendId, skipReason: waResult.skipReason }, '[ThankYou] Agradecimiento por WhatsApp omitido');
            } else {
                throw new Error(`Fallo en envío de WhatsApp: ${waResult.error || 'error desconocido'}`);
            }
        }
    } catch (sendErr: any) {
        await fastify.supabaseAdmin
            .from('thank_you_sends')
            .update({
                status: THANK_YOU_STATUSES.FALLIDO,
                skip_reason: sendErr.message,
            })
            .eq('id', sendId);

        fastify.log.error({ sendErr, leadId, sendId }, '[ThankYou] Error despachando agradecimiento');
        throw sendErr;
    }
}
