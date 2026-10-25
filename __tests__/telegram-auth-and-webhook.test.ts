import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import supabasePlugin from '../src/plugins/supabase.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { timingSafeEqualStrings } from '../src/lib/timing-safe.js';
import { resolveAndAuthenticateTelegramWebhook } from '../src/services/telegram/telegram-auth.js';
import { telegramWebhookRoutes } from '../src/routes/webhooks/telegram.js';
import { setSecret } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { TELEGRAM_PROCESS_UPDATE_QUEUE } from '../src/jobs/process-telegram-update.js';

describe('Autenticación Timing-Safe y Webhook de Telegram (telegram-auth.ts & routes/webhooks/telegram.ts)', () => {
    let app: FastifyInstance;
    let activeOrgId: string;
    let suspendedOrgId: string;
    let disabledConnOrgId: string;
    let activeConnId: string;

    const activeWebhookToken = crypto.randomBytes(24).toString('hex');
    const suspendedWebhookToken = crypto.randomBytes(24).toString('hex');
    const disabledWebhookToken = crypto.randomBytes(24).toString('hex');
    const validSecret = crypto.randomBytes(32).toString('hex');

    const sendMock = vi.fn().mockResolvedValue('job-id-123');

    beforeAll(async () => {
        app = Fastify({ logger: false });
        await app.register(supabasePlugin);
        await app.register(
            fp(async (instance) => {
                instance.decorate('pgBoss', {
                    send: sendMock,
                } as unknown as FastifyInstance['pgBoss']);
            })
        );
        await app.register(telegramWebhookRoutes);
        await app.ready();

        const suffix = Date.now();
        const { data: org1, error: err1 } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: `TG Auth Active Org ${suffix}`,
                email: `tg-auth-active-${suffix}@datagol.test`,
                plan_key: 'pro',
                status: 'active',
            })
            .select('id')
            .single();
        if (err1 || !org1) throw new Error(`Error creando org1: ${err1?.message}`);
        activeOrgId = org1.id as string;

        const { data: org2, error: err2 } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: `TG Auth Suspended Org ${suffix}`,
                email: `tg-auth-susp-${suffix}@datagol.test`,
                plan_key: 'pro',
                status: 'suspended',
                suspended_reason: 'Prueba de suspensión',
            })
            .select('id')
            .single();
        if (err2 || !org2) throw new Error(`Error creando org2: ${err2?.message}`);
        suspendedOrgId = org2.id as string;

        const { data: org3, error: err3 } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: `TG Auth Disabled Conn Org ${suffix}`,
                email: `tg-auth-dis-${suffix}@datagol.test`,
                plan_key: 'pro',
                status: 'active',
            })
            .select('id')
            .single();
        if (err3 || !org3) throw new Error(`Error creando org3: ${err3?.message}`);
        disabledConnOrgId = org3.id as string;

        const { data: conn1, error: cErr1 } = await supabaseAdmin
            .from('telegram_connections')
            .insert({
                organization_id: activeOrgId,
                bot_username: 'active_test_bot',
                telegram_bot_id: 100001 + (suffix % 100000),
                webhook_token: activeWebhookToken,
                status: 'active',
            })
            .select('id')
            .single();
        if (cErr1 || !conn1) throw new Error(`Error creando conn1: ${cErr1?.message}`);
        activeConnId = conn1.id as string;

        await supabaseAdmin.from('telegram_connections').insert([
            {
                organization_id: suspendedOrgId,
                bot_username: 'suspended_test_bot',
                telegram_bot_id: 200001 + (suffix % 100000),
                webhook_token: suspendedWebhookToken,
                status: 'active',
            },
            {
                organization_id: disabledConnOrgId,
                bot_username: 'disabled_test_bot',
                telegram_bot_id: 300001 + (suffix % 100000),
                webhook_token: disabledWebhookToken,
                status: 'disabled',
            },
        ]);

        await setSecret(activeOrgId, SECRET_KEYS.TELEGRAM_WEBHOOK_SECRET, validSecret);
        await setSecret(suspendedOrgId, SECRET_KEYS.TELEGRAM_WEBHOOK_SECRET, validSecret);
        await setSecret(disabledConnOrgId, SECRET_KEYS.TELEGRAM_WEBHOOK_SECRET, validSecret);
    });

    afterAll(async () => {
        for (const id of [activeOrgId, suspendedOrgId, disabledConnOrgId]) {
            if (id) {
                await supabaseAdmin.from('organizations').delete().eq('id', id);
            }
        }
        await app.close();
    });

    describe('timingSafeEqualStrings', () => {
        it('retorna true para cadenas idénticas no vacías y false para vacías, distinta longitud o distinto contenido', () => {
            expect(timingSafeEqualStrings('secreto-123', 'secreto-123')).toBe(true);
            expect(timingSafeEqualStrings('', '')).toBe(false);
            expect(timingSafeEqualStrings('abc', '')).toBe(false);
            expect(timingSafeEqualStrings('', 'abc')).toBe(false);
            expect(timingSafeEqualStrings('corto', 'mas-largo')).toBe(false);
            expect(timingSafeEqualStrings('secreto-123', 'secreto-124')).toBe(false);
        });
    });

    describe('resolveAndAuthenticateTelegramWebhook', () => {
        it('rechaza con 401 invalid_webhook_token cuando webhookToken es vacío, desconocido o la conexión está disabled', async () => {
            const emptyRes = await resolveAndAuthenticateTelegramWebhook(app, '   ', validSecret);
            expect(emptyRes).toEqual({
                ok: false,
                statusCode: 401,
                reason: 'invalid_webhook_token',
                message: 'Token de webhook de Telegram inválido',
            });

            const unknownRes = await resolveAndAuthenticateTelegramWebhook(
                app,
                'ffffffffffffffffffffffffffffffffffffffffffffffff',
                validSecret
            );
            expect(unknownRes).toEqual({
                ok: false,
                statusCode: 401,
                reason: 'invalid_webhook_token',
                message: 'Token de webhook de Telegram inválido',
            });

            const disabledRes = await resolveAndAuthenticateTelegramWebhook(
                app,
                disabledWebhookToken,
                validSecret
            );
            expect(disabledRes).toEqual({
                ok: false,
                statusCode: 401,
                reason: 'invalid_webhook_token',
                message: 'Token de webhook de Telegram inválido',
            });
        });

        it('rechaza con 401 invalid_secret_header cuando el header falta o no coincide (incluso en organización suspendida, evitando enumeración)', async () => {
            const missingHeader = await resolveAndAuthenticateTelegramWebhook(
                app,
                activeWebhookToken,
                undefined
            );
            expect(missingHeader).toEqual({
                ok: false,
                statusCode: 401,
                reason: 'invalid_secret_header',
                message: 'Firma secreta de Telegram inválida o ausente',
            });

            const wrongHeaderOnSuspended = await resolveAndAuthenticateTelegramWebhook(
                app,
                suspendedWebhookToken,
                'secreto-incorrecto'
            );
            // Debe responder 401 (no 403) porque el secreto se verifica antes del estado de la org
            expect(wrongHeaderOnSuspended.ok).toBe(false);
            if (!wrongHeaderOnSuspended.ok) {
                expect(wrongHeaderOnSuspended.statusCode).toBe(401);
                expect(wrongHeaderOnSuspended.reason).toBe('invalid_secret_header');
            }
        });

        it('rechaza con 403 organization_suspended solo después de verificar el secret header válido', async () => {
            const suspRes = await resolveAndAuthenticateTelegramWebhook(
                app,
                suspendedWebhookToken,
                validSecret
            );
            expect(suspRes).toEqual({
                ok: false,
                statusCode: 403,
                reason: 'organization_suspended',
                message: 'Esta organización tiene su implementación suspendida.',
            });
        });

        it('autentica exitosamente cuando webhookToken, secretHeader y organización están activos', async () => {
            const okRes = await resolveAndAuthenticateTelegramWebhook(
                app,
                activeWebhookToken,
                validSecret
            );
            expect(okRes).toEqual({
                ok: true,
                organizationId: activeOrgId,
                connectionId: activeConnId,
            });
        });
    });

    describe('POST /webhooks/telegram/:webhookToken', () => {
        it('rechaza con 400 cuando :webhookToken no cumple el formato hexadecimal (>=32 chars)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/webhooks/telegram/token-corto-no-hex',
                headers: { 'x-telegram-bot-api-secret-token': validSecret },
                payload: { update_id: 1001 },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json()).toEqual({
                error: 'BadRequest',
                message: 'webhookToken inválido en la ruta',
            });
        });

        it('rechaza con 401 cuando el secret header es inválido y con 403 cuando la organización está suspendida', async () => {
            const res401 = await app.inject({
                method: 'POST',
                url: `/webhooks/telegram/${activeWebhookToken}`,
                headers: { 'x-telegram-bot-api-secret-token': 'invalido' },
                payload: { update_id: 1002 },
            });
            expect(res401.statusCode).toBe(401);
            expect(res401.json().error).toBe('Unauthorized');

            const res403 = await app.inject({
                method: 'POST',
                url: `/webhooks/telegram/${suspendedWebhookToken}`,
                headers: { 'x-telegram-bot-api-secret-token': validSecret },
                payload: { update_id: 1003 },
            });
            expect(res403.statusCode).toBe(403);
            expect(res403.json().error).toBe('Forbidden');
        });

        it('rechaza con 400 cuando el cuerpo no es un Update válido de Telegram', async () => {
            const res = await app.inject({
                method: 'POST',
                url: `/webhooks/telegram/${activeWebhookToken}`,
                headers: { 'x-telegram-bot-api-secret-token': validSecret },
                payload: { update_id: -5 },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json()).toEqual({
                error: 'BadRequest',
                message: 'Payload de Update de Telegram inválido',
            });
        });

        it('ignora con 200 (ignored: true) updates de grupos/supergrupos/canales o enviados por un bot sin encolar job', async () => {
            sendMock.mockClear();

            const groupRes = await app.inject({
                method: 'POST',
                url: `/webhooks/telegram/${activeWebhookToken}`,
                headers: { 'x-telegram-bot-api-secret-token': validSecret },
                payload: {
                    update_id: 2001,
                    message: {
                        message_id: 10,
                        date: 1760000000,
                        chat: { id: -999888, type: 'supergroup' },
                        from: { id: 555111, is_bot: false, first_name: 'Admin' },
                        text: '¿Cuántas citas hoy?',
                    },
                },
            });
            expect(groupRes.statusCode).toBe(200);
            expect(groupRes.json()).toEqual({ ok: true, ignored: true });
            expect(sendMock).not.toHaveBeenCalled();

            const botSenderRes = await app.inject({
                method: 'POST',
                url: `/webhooks/telegram/${activeWebhookToken}`,
                headers: { 'x-telegram-bot-api-secret-token': validSecret },
                payload: {
                    update_id: 2002,
                    message: {
                        message_id: 11,
                        date: 1760000001,
                        chat: { id: 555111, type: 'private' },
                        from: { id: 555111, is_bot: true, first_name: 'OtherBot' },
                        text: 'Hola',
                    },
                },
            });
            expect(botSenderRes.statusCode).toBe(200);
            expect(botSenderRes.json()).toEqual({ ok: true, ignored: true });
            expect(sendMock).not.toHaveBeenCalled();
        });

        it('encola en pg-boss un mensaje privado válido y garantiza idempotencia en reintentos con el mismo update_id', async () => {
            sendMock.mockClear();

            const payload = {
                update_id: 3001,
                message: {
                    message_id: 50,
                    date: 1760000100,
                    chat: { id: 777888999, type: 'private' },
                    from: { id: 777888999, is_bot: false, first_name: 'Carlos', username: 'carlos_admin' },
                    text: '¿Cuántas citas tuvimos hoy?',
                },
            };

            const firstRes = await app.inject({
                method: 'POST',
                url: `/webhooks/telegram/${activeWebhookToken}`,
                headers: { 'x-telegram-bot-api-secret-token': validSecret },
                payload,
            });
            expect(firstRes.statusCode).toBe(200);
            expect(firstRes.json()).toEqual({ ok: true });
            expect(sendMock).toHaveBeenCalledTimes(1);
            expect(sendMock).toHaveBeenCalledWith(
                TELEGRAM_PROCESS_UPDATE_QUEUE,
                expect.objectContaining({
                    organizationId: activeOrgId,
                    update: expect.objectContaining({ update_id: 3001 }),
                }),
                {
                    singletonKey: `${activeOrgId}:message:3001`,
                    retryLimit: 2,
                    retryDelay: 5,
                }
            );

            // Reintento con el mismo update_id -> idempotencia por UNIQUE(provider, event_id)
            const duplicateRes = await app.inject({
                method: 'POST',
                url: `/webhooks/telegram/${activeWebhookToken}`,
                headers: { 'x-telegram-bot-api-secret-token': validSecret },
                payload,
            });
            expect(duplicateRes.statusCode).toBe(200);
            expect(duplicateRes.json()).toEqual({ ok: true, duplicate: true });
            expect(sendMock).toHaveBeenCalledTimes(1);
        });
    });
});
