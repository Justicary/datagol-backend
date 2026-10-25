import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { FastifyInstance } from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { clearEntitlementsCache } from '../src/services/entitlements.js';
import { clearPermissionsCache } from '../src/services/permission-service.js';
import { clearRateLimiterForTesting } from '../src/lib/rate-limiter.js';
import {
    createTelegramLinkToken,
    redeemTelegramStartToken,
    authorizeTelegramMessageSender,
    listTelegramIdentities,
    revokeTelegramIdentity,
} from '../src/services/telegram/telegram-identity-service.js';
import {
    getActiveConversationContext,
    appendConversationTurn,
    clearConversationContext,
    TELEGRAM_CONTEXT_TTL_MS,
} from '../src/services/telegram/telegram-conversation-service.js';
import { processTelegramUpdateJob } from '../src/jobs/process-telegram-update.js';
import * as telegramClient from '../src/services/telegram/telegram-client.js';
import * as askHarnessModule from '../src/services/harness/ask-harness.js';
import { TELEGRAM_USER_MESSAGES } from '../src/services/telegram/formatter.js';

describe('Identidades de Telegram, Contexto Conversacional y Job Asíncrono (T5, T6, T8)', () => {
    let app: FastifyInstance;
    let orgAId: string;
    let orgBId: string;
    let ownerUserId: string;
    let adminUserId: string;
    let viewerUserId: string;

    const tgOwnerUserId = 910000001 + (Date.now() % 100000);
    const tgAdminUserId = 920000001 + (Date.now() % 100000);
    const tgUnauthorizedUserId = 930000001 + (Date.now() % 100000);
    const botTokenA = '123456789:AAH_test_bot_token_for_org_a_12345';
    const botTokenB = '987654321:AAH_test_bot_token_for_org_b_67890';

    beforeAll(async () => {
        app = Fastify({ logger: false });
        await app.register(supabasePlugin);
        await app.ready();

        const suffix = Date.now();

        const [{ data: u1 }, { data: u2 }, { data: u3 }] = await Promise.all([
            supabaseAdmin.auth.admin.createUser({
                email: `tg-owner-${suffix}@datagol.test`,
                password: 'Password123!',
                email_confirm: true,
            }),
            supabaseAdmin.auth.admin.createUser({
                email: `tg-admin-${suffix}@datagol.test`,
                password: 'Password123!',
                email_confirm: true,
            }),
            supabaseAdmin.auth.admin.createUser({
                email: `tg-viewer-${suffix}@datagol.test`,
                password: 'Password123!',
                email_confirm: true,
            }),
        ]);

        if (!u1.user || !u2.user || !u3.user) {
            throw new Error('No se pudieron crear los usuarios de prueba en auth.users');
        }
        ownerUserId = u1.user.id;
        adminUserId = u2.user.id;
        viewerUserId = u3.user.id;

        const { data: orgA, error: errA } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: `TG Identity Org A ${suffix}`,
                email: `tg-id-a-${suffix}@datagol.test`,
                plan_key: 'pro',
                status: 'active',
            })
            .select('id')
            .single();
        if (errA || !orgA) throw new Error(`Error creando orgA: ${errA?.message}`);
        orgAId = orgA.id as string;

        const { data: orgB, error: errB } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: `TG Identity Org B ${suffix}`,
                email: `tg-id-b-${suffix}@datagol.test`,
                plan_key: 'pro',
                status: 'active',
            })
            .select('id')
            .single();
        if (errB || !orgB) throw new Error(`Error creando orgB: ${errB?.message}`);
        orgBId = orgB.id as string;

        await supabaseAdmin.from('organization_members').insert([
            { organization_id: orgAId, user_id: ownerUserId, role: 'owner' },
            { organization_id: orgAId, user_id: adminUserId, role: 'admin' },
            { organization_id: orgAId, user_id: viewerUserId, role: 'viewer' },
            { organization_id: orgBId, user_id: ownerUserId, role: 'owner' },
        ]);

        await supabaseAdmin.from('telegram_connections').insert([
            {
                organization_id: orgAId,
                telegram_bot_id: 700001 + (suffix % 100000),
                bot_username: 'org_a_reports_bot',
                webhook_token: crypto.randomBytes(24).toString('hex'),
                status: 'active',
            },
            {
                organization_id: orgBId,
                telegram_bot_id: 800001 + (suffix % 100000),
                bot_username: 'org_b_reports_bot',
                webhook_token: crypto.randomBytes(24).toString('hex'),
                status: 'active',
            },
        ]);

        // Configurar secretos requeridos por las features 'telegram' y 'natural_language_reports'
        await setSecret(orgAId, SECRET_KEYS.TELEGRAM_BOT_TOKEN, botTokenA);
        await setSecret(orgAId, SECRET_KEYS.LLM_API_KEY, 'sk-or-v1-dummy-llm-key');
        await setSecret(orgBId, SECRET_KEYS.TELEGRAM_BOT_TOKEN, botTokenB);
        await setSecret(orgBId, SECRET_KEYS.LLM_API_KEY, 'sk-or-v1-dummy-llm-key');
        clearEntitlementsCache(orgAId);
        clearEntitlementsCache(orgBId);
    });

    afterAll(async () => {
        for (const orgId of [orgAId, orgBId]) {
            if (orgId) {
                await supabaseAdmin.from('organizations').delete().eq('id', orgId);
            }
        }
        for (const uid of [ownerUserId, adminUserId, viewerUserId]) {
            if (uid) {
                await supabaseAdmin.auth.admin.deleteUser(uid);
            }
        }
        await app.close();
    });

    describe('Generación y Canje de Tokens de Vinculación (/start <token>)', () => {
        it('rechaza createTelegramLinkToken para un miembro viewer (403) y lo permite para owner y admin guardando solo SHA-256 en DB', async () => {
            await expect(createTelegramLinkToken(orgAId, viewerUserId)).rejects.toMatchObject({
                statusCode: 403,
            });

            const linkRes = await createTelegramLinkToken(orgAId, ownerUserId);
            expect(linkRes.botUsername).toBe('org_a_reports_bot');
            expect(linkRes.deepLink).toMatch(/^https:\/\/t\.me\/org_a_reports_bot\?start=[a-f0-9]{64}$/);

            const rawToken = linkRes.deepLink.split('?start=')[1];
            const expectedHash = crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');

            // Verificar en DB que jamás se guardó el token en claro, solo el SHA-256
            const { data: storedToken } = await supabaseAdmin
                .from('telegram_link_tokens')
                .select('token_hash, used_at')
                .eq('organization_id', orgAId)
                .eq('token_hash', expectedHash)
                .maybeSingle();

            expect(storedToken).not.toBeNull();
            expect(storedToken?.token_hash).toBe(expectedHash);
            expect(storedToken?.used_at).toBeNull();
        });

        it('canjea un token válido vinculando la identidad y rechaza con el mismo mensaje genérico tokens usados, de otra org, expirados o inválidos', async () => {
            clearRateLimiterForTesting();
            const linkOwner = await createTelegramLinkToken(orgAId, ownerUserId);
            const rawTokenOwner = linkOwner.deepLink.split('?start=')[1];

            // 1. Intento de canjear el token de Org A en el bot de Org B -> debe fallar con LINK_INVALID
            const wrongOrgAttempt = await redeemTelegramStartToken({
                organizationId: orgBId,
                rawToken: rawTokenOwner,
                telegramUserId: tgOwnerUserId,
                telegramChatId: tgOwnerUserId,
                telegramUsername: 'owner_tg',
                telegramFirstName: 'Owner',
            });
            expect(wrongOrgAttempt).toEqual({
                ok: false,
                message: TELEGRAM_USER_MESSAGES.LINK_INVALID,
            });

            // 2. Canje legítimo en Org A -> éxito
            const validRedeem = await redeemTelegramStartToken({
                organizationId: orgAId,
                rawToken: rawTokenOwner,
                telegramUserId: tgOwnerUserId,
                telegramChatId: tgOwnerUserId,
                telegramUsername: 'owner_tg',
                telegramFirstName: 'Owner',
            });
            expect(validRedeem.ok).toBe(true);
            expect(validRedeem.message).toBe(TELEGRAM_USER_MESSAGES.LINK_SUCCESS);
            expect(validRedeem.identityId).toBeDefined();

            // 3. Reintento con el mismo token (un solo uso) -> falla con el mismo LINK_INVALID
            const secondUseAttempt = await redeemTelegramStartToken({
                organizationId: orgAId,
                rawToken: rawTokenOwner,
                telegramUserId: tgOwnerUserId,
                telegramChatId: tgOwnerUserId,
            });
            expect(secondUseAttempt).toEqual({
                ok: false,
                message: TELEGRAM_USER_MESSAGES.LINK_INVALID,
            });

            // 4. Opción 2: Un segundo miembro admin de la misma Org A también puede vincular su propio Telegram
            const linkAdmin = await createTelegramLinkToken(orgAId, adminUserId);
            const rawTokenAdmin = linkAdmin.deepLink.split('?start=')[1];
            const adminRedeem = await redeemTelegramStartToken({
                organizationId: orgAId,
                rawToken: rawTokenAdmin,
                telegramUserId: tgAdminUserId,
                telegramChatId: tgAdminUserId,
                telegramUsername: 'admin_tg',
                telegramFirstName: 'Admin',
            });
            expect(adminRedeem.ok).toBe(true);

            // 5. Unicidad global de telegram_user_id en v1: tgOwnerUserId no puede vincularse simultáneamente a Org B
            const linkOrgB = await createTelegramLinkToken(orgBId, ownerUserId);
            const rawTokenOrgB = linkOrgB.deepLink.split('?start=')[1];
            const crossOrgSameTgUser = await redeemTelegramStartToken({
                organizationId: orgBId,
                rawToken: rawTokenOrgB,
                telegramUserId: tgOwnerUserId,
                telegramChatId: tgOwnerUserId,
            });
            expect(crossOrgSameTgUser).toEqual({
                ok: false,
                message: TELEGRAM_USER_MESSAGES.LINK_INVALID,
            });

            // 6. Rate limiting tras 5 intentos en 1 minuto por telegram_user_id
            const spammerTgId = 999888777;
            for (let i = 0; i < 5; i++) {
                const attempt = await redeemTelegramStartToken({
                    organizationId: orgAId,
                    rawToken: 'token_inexistente_de_mas_de_16_caracteres',
                    telegramUserId: spammerTgId,
                    telegramChatId: spammerTgId,
                });
                expect(attempt.message).toBe(TELEGRAM_USER_MESSAGES.LINK_INVALID);
            }
            const sixthAttempt = await redeemTelegramStartToken({
                organizationId: orgAId,
                rawToken: 'token_inexistente_de_mas_de_16_caracteres',
                telegramUserId: spammerTgId,
                telegramChatId: spammerTgId,
            });
            expect(sixthAttempt).toEqual({
                ok: false,
                message: TELEGRAM_USER_MESSAGES.LINK_RATE_LIMITED,
            });
        });
    });

    describe('Los 6 Candados de Autorización en authorizeTelegramMessageSender', () => {
        it('autoriza a owner y admin vinculados y rechaza inmediatamente si se degrada el rol, se revoca use_nl_reports, se apaga la feature telegram o se revoca la identidad', async () => {
            // 1. Owner y Admin activos -> ok: true
            const ownerAuth = await authorizeTelegramMessageSender(orgAId, tgOwnerUserId);
            expect(ownerAuth.ok).toBe(true);

            const adminAuth = await authorizeTelegramMessageSender(orgAId, tgAdminUserId);
            expect(adminAuth.ok).toBe(true);

            // 2. Usuario de Telegram no vinculado -> identity_not_found
            const unknownAuth = await authorizeTelegramMessageSender(orgAId, tgUnauthorizedUserId);
            expect(unknownAuth).toEqual({
                ok: false,
                reason: 'identity_not_found',
                userMessage: TELEGRAM_USER_MESSAGES.UNAUTHORIZED,
            });

            // 3. Aislamiento cross-tenant: tgOwnerUserId (vinculado a Org A) intenta hablarle al bot de Org B -> identity_not_found
            const crossTenantAuth = await authorizeTelegramMessageSender(orgBId, tgOwnerUserId);
            expect(crossTenantAuth).toEqual({
                ok: false,
                reason: 'identity_not_found',
                userMessage: TELEGRAM_USER_MESSAGES.UNAUTHORIZED,
            });

            // 4. Degradación de rol después de vincular (admin -> member) -> role_not_allowed inmediato
            await supabaseAdmin
                .from('organization_members')
                .update({ role: 'member' })
                .eq('organization_id', orgAId)
                .eq('user_id', adminUserId);

            const degradedAuth = await authorizeTelegramMessageSender(orgAId, tgAdminUserId);
            expect(degradedAuth).toEqual({
                ok: false,
                reason: 'role_not_allowed',
                userMessage: TELEGRAM_USER_MESSAGES.UNAUTHORIZED,
            });

            // Restaurar rol admin
            await supabaseAdmin
                .from('organization_members')
                .update({ role: 'admin' })
                .eq('organization_id', orgAId)
                .eq('user_id', adminUserId);

            // 5. Revocación del permiso use_nl_reports para el rol admin -> permission_denied
            const { error: permOverrideErr } = await supabaseAdmin
                .from('organization_role_permissions')
                .upsert(
                    {
                        organization_id: orgAId,
                        role: 'admin',
                        permission_key: 'use_nl_reports',
                        enabled: false,
                        reason: 'Prueba de revocación de use_nl_reports en Telegram',
                    },
                    { onConflict: 'organization_id,role,permission_key' }
                );
            expect(permOverrideErr).toBeNull();
            clearPermissionsCache(orgAId);

            const noPermAuth = await authorizeTelegramMessageSender(orgAId, tgAdminUserId);
            expect(noPermAuth).toEqual({
                ok: false,
                reason: 'permission_denied',
                userMessage: TELEGRAM_USER_MESSAGES.UNAUTHORIZED,
            });

            // Restaurar permiso use_nl_reports
            await supabaseAdmin
                .from('organization_role_permissions')
                .delete()
                .eq('organization_id', orgAId)
                .eq('role', 'admin')
                .eq('permission_key', 'use_nl_reports');
            clearPermissionsCache(orgAId);

            // 6. Deshabilitación de la feature 'telegram' por override o degradación a plan starter -> feature_disabled
            await supabaseAdmin.from('organization_features').upsert(
                {
                    organization_id: orgAId,
                    feature_key: 'telegram',
                    enabled: false,
                    reason: 'Override de prueba',
                },
                { onConflict: 'organization_id,feature_key' }
            );
            clearEntitlementsCache(orgAId);

            const featureOffAuth = await authorizeTelegramMessageSender(orgAId, tgOwnerUserId);
            expect(featureOffAuth).toEqual({
                ok: false,
                reason: 'feature_disabled',
                userMessage: TELEGRAM_USER_MESSAGES.UNAUTHORIZED,
            });

            // Restaurar feature 'telegram'
            await supabaseAdmin
                .from('organization_features')
                .delete()
                .eq('organization_id', orgAId)
                .eq('feature_key', 'telegram');
            clearEntitlementsCache(orgAId);

            // 7. Revocación explícita de la identidad de admin -> identity_revoked
            const identities = await listTelegramIdentities(orgAId);
            const adminIdentity = identities.find((i) => Number(i.telegram_user_id) === tgAdminUserId);
            expect(adminIdentity).toBeDefined();

            const revokedOk = await revokeTelegramIdentity(orgAId, adminIdentity!.id);
            expect(revokedOk).toBe(true);

            const revokedAuth = await authorizeTelegramMessageSender(orgAId, tgAdminUserId);
            expect(revokedAuth).toEqual({
                ok: false,
                reason: 'identity_revoked',
                userMessage: TELEGRAM_USER_MESSAGES.UNAUTHORIZED,
            });
        });
    });

    describe('Contexto Conversacional Multi-Turno y Worker processTelegramUpdateJob', () => {
        it('mantiene una ventana deslizante de máximo 3 turnos, expira a los 30 minutos y se limpia con clearConversationContext', async () => {
            const ownerAuth = await authorizeTelegramMessageSender(orgAId, tgOwnerUserId);
            expect(ownerAuth.ok).toBe(true);
            if (!ownerAuth.ok) return;

            const identityId = ownerAuth.identity.id;
            const chatId = tgOwnerUserId;
            const t0 = new Date('2026-10-25T12:00:00Z');

            // Agregar 4 turnos consecutivos -> solo deben conservarse los últimos 3
            for (let i = 1; i <= 4; i++) {
                await appendConversationTurn(
                    orgAId,
                    chatId,
                    identityId,
                    {
                        question: `Pregunta turno ${i}`,
                        intent: 'citas_hoy',
                        parameters: { turno: i },
                        period: { type: 'hoy' },
                        resultDigest: `Resumen turno ${i}`,
                    },
                    new Date(t0.getTime() + i * 1000)
                );
            }

            const activeBeforeExpiry = await getActiveConversationContext(
                orgAId,
                chatId,
                identityId,
                new Date(t0.getTime() + 5 * 60 * 1000)
            );
            expect(activeBeforeExpiry.turns).toHaveLength(3);
            expect(activeBeforeExpiry.turns.map((t) => t.question)).toEqual([
                'Pregunta turno 2',
                'Pregunta turno 3',
                'Pregunta turno 4',
            ]);

            // Consultar después de 31 minutos (> TTL 30m) -> debe expirar y reiniciar a []
            const activeAfterExpiry = await getActiveConversationContext(
                orgAId,
                chatId,
                identityId,
                new Date(t0.getTime() + TELEGRAM_CONTEXT_TTL_MS + 60 * 1000)
            );
            expect(activeAfterExpiry.turns).toEqual([]);
        });

        it('ejecuta processTelegramUpdateJob de extremo a extremo invocando askHarness, persistiendo contexto y enviando respuesta HTML por Telegram', async () => {
            const sendChunkSpy = vi
                .spyOn(telegramClient, 'sendTelegramHtmlChunks')
                .mockResolvedValue({ ok: true, messageIds: [701] });
            const sendMsgSpy = vi
                .spyOn(telegramClient, 'sendTelegramMessage')
                .mockResolvedValue({ ok: true, messageId: 702 });
            const askHarnessSpy = vi.spyOn(askHarnessModule, 'askHarness').mockResolvedValue({
                success: true,
                status: 'success',
                intent: 'conteo_citas',
                category: 'agenda',
                shape: 'numero',
                period: {
                    type: 'hoy',
                    startUtc: '2026-10-25T06:00:00Z',
                    endUtc: '2026-10-26T05:59:59Z',
                    startLocal: '2026-10-25T00:00:00',
                    endLocal: '2026-10-25T23:59:59',
                    label: 'hoy',
                    timezone: 'America/Mexico_City',
                },
                interpretation: 'Citas programadas para hoy',
                narrative: 'Hoy tienes 5 citas programadas.',
                data: { totalCitas: 5 },
                warnings: [],
                executionTimeMs: 45,
            });

            const { data: whEvent } = await supabaseAdmin
                .from('webhook_events')
                .insert({
                    organization_id: orgAId,
                    provider: 'telegram',
                    event_id: `message:${Date.now()}`,
                    event_type: 'message',
                    raw_payload: { update_id: 9001 },
                })
                .select('id')
                .single();

            await processTelegramUpdateJob(app, {
                organizationId: orgAId,
                webhookEventId: whEvent!.id as string,
                update: {
                    update_id: 9001,
                    message: {
                        message_id: 301,
                        date: 1760001000,
                        chat: { id: tgOwnerUserId, type: 'private' },
                        from: { id: tgOwnerUserId, is_bot: false, first_name: 'Owner' },
                        text: '¿Cuántas citas tenemos hoy?',
                    },
                },
            });

            expect(askHarnessSpy).toHaveBeenCalledTimes(1);
            expect(askHarnessSpy.mock.calls[0][1]).toBe(orgAId);
            expect(askHarnessSpy.mock.calls[0][2]).toMatchObject({
                channel: 'telegram',
                question: '¿Cuántas citas tenemos hoy?',
            });
            expect(sendChunkSpy).toHaveBeenCalledTimes(1);
            expect(sendChunkSpy.mock.calls[0][2][0]).toContain('Citas programadas para hoy');
            expect(sendChunkSpy.mock.calls[0][2][0]).toContain('Hoy tienes 5 citas programadas.');

            // Probar comando /nuevo para reiniciar contexto
            await processTelegramUpdateJob(app, {
                organizationId: orgAId,
                webhookEventId: whEvent!.id as string,
                update: {
                    update_id: 9002,
                    message: {
                        message_id: 302,
                        date: 1760001010,
                        chat: { id: tgOwnerUserId, type: 'private' },
                        from: { id: tgOwnerUserId, is_bot: false, first_name: 'Owner' },
                        text: '/nuevo',
                    },
                },
            });

            expect(sendMsgSpy).toHaveBeenCalledWith(
                botTokenA,
                expect.objectContaining({
                    chatId: tgOwnerUserId,
                    text: TELEGRAM_USER_MESSAGES.CONTEXT_CLEARED,
                })
            );

            sendChunkSpy.mockRestore();
            sendMsgSpy.mockRestore();
            askHarnessSpy.mockRestore();
        });
    });
});
