import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationTelegramRoutes from '../src/routes/organization-telegram.js';
import * as orgAuth from '../src/lib/organization-auth.js';
import * as permissionService from '../src/services/permission-service.js';
import * as entitlementsService from '../src/services/entitlements.js';
import * as connectionService from '../src/services/telegram/telegram-connection-service.js';
import * as identityService from '../src/services/telegram/telegram-identity-service.js';
import { PERMISSION_KEYS } from '../src/types/permission-keys.js';

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(organizationTelegramRoutes);
    await app.ready();
    return app;
}

describe('Rutas Administrativas de Telegram por Organización (routes/organization-telegram.ts)', () => {
    let app: FastifyInstance;
    const orgId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const userId = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
    const identityId = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
    const validBotToken = '123456789:AAH_valid_bot_token_string_123456';

    beforeAll(async () => {
        app = await buildTestApp();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe('Guardas de Autenticación, Permisos RBAC y Feature Entitlement', () => {
        it('rechaza con 400 cuando :id no es un UUID válido', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/organizations/no-es-uuid/telegram',
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().error).toContain('UUID válido');
        });

        it('rechaza con 403 PERMISSION_DENIED cuando falta el permiso manage_credentials o use_nl_reports', async () => {
            vi.spyOn(orgAuth, 'requireAuthenticatedUser').mockResolvedValue({ userId, jwt: 'mock-jwt' });
            vi.spyOn(permissionService, 'getPermissionsForUser').mockResolvedValue(new Set(['view_contacts']));

            const resGet = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/telegram`,
                headers: { authorization: 'Bearer mock-jwt' },
            });
            expect(resGet.statusCode).toBe(403);
            expect(resGet.json().code).toBe('PERMISSION_DENIED');
            expect(resGet.json().requiredPermission).toBe(PERMISSION_KEYS.MANAGE_CREDENTIALS);

            const resLink = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/telegram/link-tokens`,
                headers: { authorization: 'Bearer mock-jwt' },
            });
            expect(resLink.statusCode).toBe(403);
            expect(resLink.json().requiredPermission).toBe(PERMISSION_KEYS.USE_NL_REPORTS);
        });

        it('rechaza con 403 FEATURE_DISABLED cuando la organización no tiene la feature "telegram" activa (ej. Plan Starter)', async () => {
            vi.spyOn(orgAuth, 'requireAuthenticatedUser').mockResolvedValue({ userId, jwt: 'mock-jwt' });
            vi.spyOn(permissionService, 'getPermissionsForUser').mockResolvedValue(
                new Set([PERMISSION_KEYS.MANAGE_CREDENTIALS, PERMISSION_KEYS.USE_NL_REPORTS])
            );
            vi.spyOn(entitlementsService, 'isFeatureEnabled').mockResolvedValue(false);

            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/telegram`,
                headers: { authorization: 'Bearer mock-jwt' },
            });
            expect(res.statusCode).toBe(403);
            expect(res.json().code).toBe('FEATURE_DISABLED');
            expect(res.json().requiredFeature).toBe('telegram');
        });
    });

    describe('GET / POST / DELETE /api/organizations/:id/telegram y subrutas', () => {
        beforeEach(() => {
            vi.spyOn(orgAuth, 'requireAuthenticatedUser').mockResolvedValue({ userId, jwt: 'mock-jwt' });
            vi.spyOn(permissionService, 'getPermissionsForUser').mockResolvedValue(
                new Set([PERMISSION_KEYS.MANAGE_CREDENTIALS, PERMISSION_KEYS.USE_NL_REPORTS])
            );
            vi.spyOn(entitlementsService, 'isFeatureEnabled').mockResolvedValue(true);
        });

        it('GET /api/organizations/:id/telegram devuelve estado de conexión e identidades sin exponer tokens secretos', async () => {
            vi.spyOn(connectionService, 'getTelegramConnectionStatus').mockResolvedValue({
                connected: true,
                botId: 123456789,
                botUsername: 'datagol_exec_bot',
                botFirstName: 'Datagol Bot',
                webhookRegisteredAt: '2026-10-25T12:00:00Z',
                status: 'active',
                lastError: null,
                hasBotTokenInVault: true,
                hasWebhookSecretInVault: true,
            });
            vi.spyOn(identityService, 'listTelegramIdentities').mockResolvedValue([
                {
                    id: identityId,
                    organization_id: orgId,
                    organization_member_id: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
                    user_id: userId,
                    telegram_user_id: 777888,
                    telegram_chat_id: 777888,
                    telegram_username: 'admin_user',
                    telegram_first_name: 'Admin',
                    status: 'active',
                    linked_at: '2026-10-25T10:00:00Z',
                    revoked_at: null,
                    last_seen_at: '2026-10-25T11:00:00Z',
                    created_at: '2026-10-25T10:00:00Z',
                    updated_at: '2026-10-25T11:00:00Z',
                },
            ]);

            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/telegram`,
                headers: { authorization: 'Bearer mock-jwt' },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.success).toBe(true);
            expect(body.data.connection.botUsername).toBe('datagol_exec_bot');
            expect(body.data.identities).toHaveLength(1);
            expect(JSON.stringify(body)).not.toContain('webhook_token');
            expect(JSON.stringify(body)).not.toContain('telegram_bot_token');
        });

        it('POST /api/organizations/:id/telegram valida formato de botToken (400) y guarda conexión válida (200)', async () => {
            const badRes = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/telegram`,
                headers: { authorization: 'Bearer mock-jwt' },
                payload: { botToken: 'token-invalido' },
            });
            expect(badRes.statusCode).toBe(400);

            vi.spyOn(connectionService, 'upsertTelegramConnection').mockResolvedValue({
                connected: true,
                botId: 123456789,
                botUsername: 'datagol_exec_bot',
                botFirstName: 'Datagol Bot',
                webhookRegisteredAt: null,
                status: 'active',
                lastError: null,
                hasBotTokenInVault: true,
                hasWebhookSecretInVault: true,
            });

            const okRes = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/telegram`,
                headers: { authorization: 'Bearer mock-jwt' },
                payload: { botToken: validBotToken },
            });
            expect(okRes.statusCode).toBe(200);
            expect(okRes.json().data.connected).toBe(true);
        });

        it('POST /api/organizations/:id/telegram/validate y /webhook responden adecuadamente en éxito y error', async () => {
            vi.spyOn(connectionService, 'validateTelegramConnection').mockResolvedValueOnce({
                valid: true,
                bot: { id: 123456789, username: 'datagol_exec_bot', firstName: 'Datagol Bot' },
            });

            const valOk = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/telegram/validate`,
                headers: { authorization: 'Bearer mock-jwt' },
                payload: { botToken: validBotToken },
            });
            expect(valOk.statusCode).toBe(200);
            expect(valOk.json().valid).toBe(true);

            vi.spyOn(connectionService, 'registerTelegramConnectionWebhook').mockRejectedValueOnce(
                new connectionService.TelegramConnectionError(
                    'La variable de entorno BACKEND_WEBHOOK_URL no está configurada',
                    400
                )
            );

            const whErr = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/telegram/webhook`,
                headers: { authorization: 'Bearer mock-jwt' },
            });
            expect(whErr.statusCode).toBe(400);
            expect(whErr.json().error).toContain('BACKEND_WEBHOOK_URL');
        });

        it('POST /api/organizations/:id/telegram/link-tokens genera deepLink (201) y DELETE .../identities/:identityId revoca identidad (200/404)', async () => {
            vi.spyOn(identityService, 'createTelegramLinkToken').mockResolvedValue({
                deepLink: 'https://t.me/datagol_exec_bot?start=abcdef123456',
                botUsername: 'datagol_exec_bot',
                expiresAt: '2026-10-25T12:15:00Z',
            });

            const linkRes = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/telegram/link-tokens`,
                headers: { authorization: 'Bearer mock-jwt' },
            });
            expect(linkRes.statusCode).toBe(201);
            expect(linkRes.json().data.deepLink).toContain('https://t.me/datagol_exec_bot?start=');

            vi.spyOn(identityService, 'revokeTelegramIdentity')
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(false);

            const delOk = await app.inject({
                method: 'DELETE',
                url: `/api/organizations/${orgId}/telegram/identities/${identityId}`,
                headers: { authorization: 'Bearer mock-jwt' },
            });
            expect(delOk.statusCode).toBe(200);

            const del404 = await app.inject({
                method: 'DELETE',
                url: `/api/organizations/${orgId}/telegram/identities/${identityId}`,
                headers: { authorization: 'Bearer mock-jwt' },
            });
            expect(del404.statusCode).toBe(404);
        });
    });
});
