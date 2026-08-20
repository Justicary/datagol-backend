import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationThankYouRoutes, { clearThankYouRateLimits } from '../src/routes/organization-thank-you.js';
import organizationAttachmentsRoutes from '../src/routes/organization-attachments.js';
import * as emailService from '../src/services/email.js';
import * as whatsAppService from '../src/services/thank-you-whatsapp.js';
import * as attachmentService from '../src/services/attachment-service.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
    await app.register(supabasePlugin);
    await app.register(organizationThankYouRoutes);
    await app.register(organizationAttachmentsRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
    email: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-thankyou-admin-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
    });
    if (createErr || !created.user) {
        throw new Error(`No se pudo crear el usuario de prueba: ${createErr?.message}`);
    }

    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) {
        throw new Error(`No se pudo iniciar sesión de prueba: ${signInErr?.message}`);
    }

    return { userId: created.user.id, jwt: session.session.access_token, email };
}

describe('Rutas HTTP de Agradecimiento Automático y Adjuntos', () => {
    let app: FastifyInstance;
    let owner: TestUser;
    let member: TestUser;
    let outsider: TestUser;
    let orgId: string;

    beforeAll(async () => {
        app = await buildTestApp();
        [owner, member, outsider] = await Promise.all([
            createTestUserWithJwt(),
            createTestUserWithJwt(),
            createTestUserWithJwt(),
        ]);

        // Crear organización con owner mediante RPC canónico
        const { data: org, error: orgErr } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Org Agradecimiento Test',
            p_email: `org-thankyou-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: '+525512345678',
            p_user_id: owner.userId,
        });

        if (orgErr || !org) {
            throw new Error(`No se pudo crear la organización de prueba: ${orgErr?.message}`);
        }
        orgId = org.id;

        // Asignar settings iniciales
        await supabaseAdmin
            .from('organizations')
            .update({
                integration_settings: {
                    thankYou: {
                        enabled: true,
                        dedupeWindowDays: 30,
                        emailSubject: 'Asunto de Prueba',
                    },
                },
            })
            .eq('id', orgId);

        // Asignar rol member
        await supabaseAdmin.from('organization_members').insert({
            organization_id: orgId,
            user_id: member.userId,
            role: 'member',
        });
    });

    afterAll(async () => {
        await app.close();
        if (orgId) {
            await supabaseAdmin.from('thank_you_sends').delete().eq('organization_id', orgId);
            await supabaseAdmin.from('organization_attachments').delete().eq('organization_id', orgId);
            await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
            await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        }
        await Promise.all([
            supabaseAdmin.auth.admin.deleteUser(owner.userId),
            supabaseAdmin.auth.admin.deleteUser(member.userId),
            supabaseAdmin.auth.admin.deleteUser(outsider.userId),
        ]);
    });

    beforeEach(() => {
        clearThankYouRateLimits();
        vi.spyOn(attachmentService, 'getActiveOrganizationAttachment').mockResolvedValue(null);
    });

    describe('GET /api/organizations/:id/thank-you', () => {
        it('permite a cualquier miembro de la organización consultar la configuración', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/thank-you`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });

            expect(res.statusCode).toBe(200);
            const json = res.json();
            expect(json.success).toBe(true);
            expect(json.data.enabled).toBe(true);
            expect(json.data.dedupeWindowDays).toBe(30);
            expect(json.data.emailSubject).toBe('Asunto de Prueba');
        });

        it('rechaza a usuarios que no pertenecen a la organización (403)', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/thank-you`,
                headers: { authorization: `Bearer ${outsider.jwt}` },
            });

            expect(res.statusCode).toBe(403);
        });

        it('rechaza peticiones sin token JWT (401)', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/thank-you`,
            });

            expect(res.statusCode).toBe(401);
        });
    });

    describe('PATCH /api/organizations/:id/thank-you', () => {
        it('permite a un owner/admin actualizar la configuración', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${orgId}/thank-you`,
                headers: {
                    authorization: `Bearer ${owner.jwt}`,
                    'content-type': 'application/json',
                },
                payload: {
                    enabled: false,
                    dedupeWindowDays: 15,
                    emailSubject: 'Nuevo Asunto 2026',
                    emailBody: 'Cuerpo actualizado.',
                },
            });

            expect(res.statusCode).toBe(200);
            const json = res.json();
            expect(json.success).toBe(true);
            expect(json.data.enabled).toBe(false);
            expect(json.data.dedupeWindowDays).toBe(15);
            expect(json.data.emailSubject).toBe('Nuevo Asunto 2026');
        });

        it('rechaza a un miembro regular con rol member (403)', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${orgId}/thank-you`,
                headers: {
                    authorization: `Bearer ${member.jwt}`,
                    'content-type': 'application/json',
                },
                payload: { enabled: true },
            });

            expect(res.statusCode).toBe(403);
        });

        it('valida el cuerpo con Zod y rechaza parámetros fuera de rango (400)', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${orgId}/thank-you`,
                headers: {
                    authorization: `Bearer ${owner.jwt}`,
                    'content-type': 'application/json',
                },
                payload: { dedupeWindowDays: -5 },
            });

            expect(res.statusCode).toBe(400);
        });
    });

    describe('POST /api/organizations/:id/thank-you/test', () => {
        it('envía prueba por correo al admin', async () => {
            vi.spyOn(emailService, 'sendThankYouEmail').mockResolvedValue({ data: { id: 'email-test-id' } } as any);

            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/thank-you/test`,
                headers: {
                    authorization: `Bearer ${owner.jwt}`,
                    'content-type': 'application/json',
                },
                payload: {
                    channel: 'email',
                    to: 'admin@negocio.com',
                },
            });

            expect(res.statusCode).toBe(200);
            const json = res.json();
            expect(json.success).toBe(true);
            expect(json.data.channel).toBe('email');
            expect(json.data.recipient).toBe('admin@negocio.com');
            expect(emailService.sendThankYouEmail).toHaveBeenCalledTimes(1);
        });

        it('envía prueba por WhatsApp al teléfono especificado', async () => {
            vi.spyOn(whatsAppService, 'sendThankYouWhatsApp').mockResolvedValue({ sent: true, waMessageId: 'wa-test-id' });

            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/thank-you/test`,
                headers: {
                    authorization: `Bearer ${owner.jwt}`,
                    'content-type': 'application/json',
                },
                payload: {
                    channel: 'whatsapp',
                    to: '+525599887766',
                },
            });

            expect(res.statusCode).toBe(200);
            const json = res.json();
            expect(json.success).toBe(true);
            expect(json.data.channel).toBe('whatsapp');
            expect(json.data.recipient).toBe('+525599887766');
            expect(whatsAppService.sendThankYouWhatsApp).toHaveBeenCalledTimes(1);
        });

        it('aplica límite de tasa (máximo 5 envíos de prueba cada 15 min) (429)', async () => {
            vi.spyOn(emailService, 'sendThankYouEmail').mockResolvedValue({ data: { id: 'ok' } } as any);
            vi.spyOn(attachmentService, 'getActiveOrganizationAttachment').mockResolvedValue(null);

            // 5 envíos permitidos
            for (let i = 0; i < 5; i++) {
                const r = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/thank-you/test`,
                    headers: {
                        authorization: `Bearer ${owner.jwt}`,
                        'content-type': 'application/json',
                    },
                    payload: { channel: 'email', to: 'admin@test.com' },
                });
                expect(r.statusCode).toBe(200);
            }

            // El 6to debe ser rechazado con 429
            const rejected = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/thank-you/test`,
                headers: {
                    authorization: `Bearer ${owner.jwt}`,
                    'content-type': 'application/json',
                },
                payload: { channel: 'email', to: 'admin@test.com' },
            });

            expect(rejected.statusCode).toBe(429);
            expect(rejected.json().error).toContain('Límite de envíos de prueba alcanzado');
        });
    });

    describe('GET /api/organizations/:id/thank-you/log', () => {
        it('retorna lista paginada de logs', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/thank-you/log?page=1&limit=10`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });

            expect(res.statusCode).toBe(200);
            const json = res.json();
            expect(json.success).toBe(true);
            expect(Array.isArray(json.data)).toBe(true);
            expect(json.pagination).toBeDefined();
            expect(json.pagination.page).toBe(1);
            expect(json.pagination.limit).toBe(10);
        });
    });

    describe('DELETE /api/organizations/:id/thank-you/log/:sendId', () => {
        let contactId: string;
        let omitidoSendId: string;
        let fallidoSendId: string;
        let enviadoSendId: string;

        beforeAll(async () => {
            const { data: contact } = await supabaseAdmin
                .from('contacts')
                .insert({
                    organization_id: orgId,
                    full_name: 'Contacto Para Delete Log',
                    email: `delete-log-${crypto.randomUUID()}@example.invalid`,
                })
                .select('id')
                .single();
            contactId = contact!.id;

            const { data: s1 } = await supabaseAdmin
                .from('thank_you_sends')
                .insert({
                    organization_id: orgId,
                    contact_id: contactId,
                    channel: 'email',
                    status: 'omitido',
                    skip_reason: 'sin_canal_disponible',
                })
                .select('id')
                .single();
            omitidoSendId = s1!.id;

            const { data: s2 } = await supabaseAdmin
                .from('thank_you_sends')
                .insert({
                    organization_id: orgId,
                    contact_id: contactId,
                    channel: 'email',
                    status: 'fallido',
                    skip_reason: 'Fallo de entrega SMTP',
                })
                .select('id')
                .single();
            fallidoSendId = s2!.id;

            const { data: s3 } = await supabaseAdmin
                .from('thank_you_sends')
                .insert({
                    organization_id: orgId,
                    contact_id: contactId,
                    channel: 'email',
                    status: 'enviado',
                    sent_at: new Date().toISOString(),
                })
                .select('id')
                .single();
            enviadoSendId = s3!.id;
        });

        it('rechaza con 403 si un miembro no-admin intenta eliminar', async () => {
            const res = await app.inject({
                method: 'DELETE',
                url: `/api/organizations/${orgId}/thank-you/log/${omitidoSendId}`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });
            expect(res.statusCode).toBe(403);
        });

        it('rechaza con 404 si el sendId no existe en la organización', async () => {
            const fakeId = crypto.randomUUID();
            const res = await app.inject({
                method: 'DELETE',
                url: `/api/organizations/${orgId}/thank-you/log/${fakeId}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(res.statusCode).toBe(404);
            expect(res.json().error).toBe('Registro de auditoría no encontrado.');
        });

        it('REGLA ESTRICTA: rechaza con 400 si el registro tiene estado "enviado"', async () => {
            const res = await app.inject({
                method: 'DELETE',
                url: `/api/organizations/${orgId}/thank-you/log/${enviadoSendId}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().error).toContain('Solo se pueden eliminar registros con estado "omitido" o "fallido"');
        });

        it('elimina exitosamente un registro con estado "omitido"', async () => {
            const res = await app.inject({
                method: 'DELETE',
                url: `/api/organizations/${orgId}/thank-you/log/${omitidoSendId}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().success).toBe(true);

            const { data } = await supabaseAdmin.from('thank_you_sends').select('id').eq('id', omitidoSendId).maybeSingle();
            expect(data).toBeNull();
        });

        it('elimina exitosamente un registro con estado "fallido"', async () => {
            const res = await app.inject({
                method: 'DELETE',
                url: `/api/organizations/${orgId}/thank-you/log/${fallidoSendId}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().success).toBe(true);

            const { data } = await supabaseAdmin.from('thank_you_sends').select('id').eq('id', fallidoSendId).maybeSingle();
            expect(data).toBeNull();
        });
    });

    describe('POST /api/organizations/:id/thank-you/resend', () => {
        let resendContactId: string;
        let resendContactEmail: string;
        let failedSendId: string;

        beforeAll(async () => {
            resendContactEmail = `resend-prospect-${crypto.randomUUID()}@example.invalid`;
            const { data: contact } = await supabaseAdmin
                .from('contacts')
                .insert({
                    organization_id: orgId,
                    full_name: 'Prospecto Para Reenvío',
                    email: resendContactEmail,
                })
                .select('id')
                .single();
            resendContactId = contact!.id;

            const { data: sendRow } = await supabaseAdmin
                .from('thank_you_sends')
                .insert({
                    organization_id: orgId,
                    contact_id: resendContactId,
                    channel: 'email',
                    status: 'fallido',
                    skip_reason: 'Fallo previo',
                })
                .select('id')
                .single();
            failedSendId = sendRow!.id;
        });

        beforeEach(() => {
            vi.spyOn(emailService, 'sendThankYouEmail').mockResolvedValue({ id: 'resend-email-msg-123' } as any);
        });

        it('rechaza con 400 si el cuerpo está vacío (sin sendId, contactId ni email)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/thank-you/resend`,
                headers: { authorization: `Bearer ${owner.jwt}` },
                payload: {},
            });
            expect(res.statusCode).toBe(400);
        });

        it('rechaza con 403 si un miembro no-admin intenta reenviar', async () => {
            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/thank-you/resend`,
                headers: { authorization: `Bearer ${member.jwt}` },
                payload: { sendId: failedSendId },
            });
            expect(res.statusCode).toBe(403);
        });

        it('reenvía exitosamente por sendId y actualiza el registro existente a enviado', async () => {
            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/thank-you/resend`,
                headers: { authorization: `Bearer ${owner.jwt}` },
                payload: { sendId: failedSendId },
            });

            expect(res.statusCode).toBe(200);
            const json = res.json();
            expect(json.success).toBe(true);
            expect(json.data.sendId).toBe(failedSendId);
            expect(json.data.recipient).toBe(resendContactEmail);
            expect(emailService.sendThankYouEmail).toHaveBeenCalledWith(
                expect.objectContaining({
                    organizationId: orgId,
                    to: resendContactEmail,
                })
            );

            // Verificar que se actualizó en la BD a 'enviado' y sent_at poblado
            const { data: updated } = await supabaseAdmin
                .from('thank_you_sends')
                .select('status, sent_at, skip_reason')
                .eq('id', failedSendId)
                .single();

            expect(updated?.status).toBe('enviado');
            expect(updated?.sent_at).toBeTruthy();
            expect(updated?.skip_reason).toBeNull();
        });

        it('reenvía exitosamente por contactId insertando un nuevo registro de auditoría', async () => {
            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/thank-you/resend`,
                headers: { authorization: `Bearer ${owner.jwt}` },
                payload: { contactId: resendContactId },
            });

            expect(res.statusCode).toBe(200);
            const json = res.json();
            expect(json.success).toBe(true);
            expect(json.data.recipient).toBe(resendContactEmail);
            expect(json.data.sendId).toBeTruthy();

            const { data: newRecord } = await supabaseAdmin
                .from('thank_you_sends')
                .select('status, contact_id')
                .eq('id', json.data.sendId)
                .single();

            expect(newRecord?.status).toBe('enviado');
            expect(newRecord?.contact_id).toBe(resendContactId);
        });

        it('reenvía exitosamente por email directo', async () => {
            const directEmail = `direct-${crypto.randomUUID()}@example.invalid`;
            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/thank-you/resend`,
                headers: { authorization: `Bearer ${owner.jwt}` },
                payload: { email: directEmail },
            });

            expect(res.statusCode).toBe(200);
            const json = res.json();
            expect(json.success).toBe(true);
            expect(json.data.recipient).toBe(directEmail);
        });
    });

    describe('Gestión de Adjuntos (POST, GET, DELETE /attachments)', () => {
        it('POST /attachments sube un PDF válido y lo activa', async () => {
            const mockRecord = {
                id: 'att-route-test-123',
                organization_id: orgId,
                file_name: 'catalogo.pdf',
                mime_type: 'application/pdf',
                size_bytes: 150,
                storage_path: `${orgId}/catalogo.pdf`,
                is_active: true,
                uploaded_by: owner.userId,
                created_at: new Date().toISOString(),
                archived_at: null,
            };

            vi.spyOn(attachmentService, 'uploadOrganizationAttachment').mockResolvedValue(mockRecord as any);

            const boundary = '----WebKitFormBoundaryTest12345';
            const pdfData = Buffer.from('%PDF-1.7\nSample content');

            const payload = Buffer.concat([
                Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="catalogo.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
                pdfData,
                Buffer.from(`\r\n--${boundary}--\r\n`),
            ]);

            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/attachments`,
                headers: {
                    authorization: `Bearer ${owner.jwt}`,
                    'content-type': `multipart/form-data; boundary=${boundary}`,
                },
                payload,
            });

            expect(res.statusCode).toBe(201);
            const json = res.json();
            expect(json.success).toBe(true);
            expect(json.data.id).toBe('att-route-test-123');
        });

        it('GET /attachments lista los adjuntos de la organización', async () => {
            vi.spyOn(attachmentService, 'listOrganizationAttachments').mockResolvedValue([
                { id: 'att-1', file_name: 'doc.pdf', is_active: true } as any,
            ]);

            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/attachments`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });

            expect(res.statusCode).toBe(200);
            const json = res.json();
            expect(json.success).toBe(true);
            expect(json.data).toHaveLength(1);
        });

        it('DELETE /attachments/:attId archiva el adjunto', async () => {
            vi.spyOn(attachmentService, 'archiveOrganizationAttachment').mockResolvedValue(true);

            const attUuid = crypto.randomUUID();
            const res = await app.inject({
                method: 'DELETE',
                url: `/api/organizations/${orgId}/attachments/${attUuid}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });

            expect(res.statusCode).toBe(200);
            expect(res.json().success).toBe(true);
            expect(attachmentService.archiveOrganizationAttachment).toHaveBeenCalledWith(
                expect.anything(),
                orgId,
                attUuid
            );
        });
    });
});
