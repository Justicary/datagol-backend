import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuthenticatedUser } from '../lib/organization-auth.js';
import { getPermissionsForUser } from '../services/permission-service.js';
import { isFeatureEnabled } from '../services/entitlements.js';
import { PERMISSION_KEYS, type PermissionKey } from '../types/permission-keys.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { organizationIdParamsSchema } from '../schemas/organization-onboarding.js';
import {
    upsertTelegramConnectionBodySchema,
    validateTelegramTokenBodySchema,
    telegramIdentityIdParamsSchema,
} from '../schemas/telegram.js';
import {
    getTelegramConnectionStatus,
    upsertTelegramConnection,
    validateTelegramConnection,
    registerTelegramConnectionWebhook,
    deleteTelegramConnection,
    TelegramConnectionError,
} from '../services/telegram/telegram-connection-service.js';
import {
    createTelegramLinkToken,
    listTelegramIdentities,
    revokeTelegramIdentity,
    TelegramIdentityError,
} from '../services/telegram/telegram-identity-service.js';

/**
 * Rutas administrativas por organización para configurar el Bot de Telegram
 * y gestionar la vinculación de cuentas de administradores (`owner`/`admin`).
 */
export async function organizationTelegramRoutes(fastify: FastifyInstance) {
    async function authorizeTelegramConfig(
        request: FastifyRequest,
        reply: FastifyReply,
        requiredPermission: PermissionKey = PERMISSION_KEYS.MANAGE_CREDENTIALS
    ): Promise<{ userId: string; jwt: string; organizationId: string } | null> {
        const paramsResult = organizationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({
                success: false,
                error: 'El parámetro de ruta "id" debe ser un UUID válido.',
            });
            return null;
        }

        const organizationId = paramsResult.data.id;
        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const permissions = await getPermissionsForUser(organizationId, auth.userId, auth.jwt);
        if (!permissions.has(requiredPermission)) {
            reply.status(403).send({
                success: false,
                error: 'Forbidden',
                code: 'PERMISSION_DENIED',
                message: `No tiene el permiso "${requiredPermission}" en esta organización, o no pertenece a ella.`,
                requiredPermission,
            });
            return null;
        }

        const telegramEnabled = await isFeatureEnabled(organizationId, FEATURE_KEYS.TELEGRAM);
        if (!telegramEnabled) {
            reply.status(403).send({
                success: false,
                error: 'Forbidden',
                code: 'FEATURE_DISABLED',
                message: 'La característica "telegram" no está habilitada para el plan actual de esta organización.',
                requiredFeature: FEATURE_KEYS.TELEGRAM,
            });
            return null;
        }

        return { userId: auth.userId, jwt: auth.jwt, organizationId };
    }

    /**
     * GET /api/organizations/:id/telegram
     * Devuelve el estado de conexión del Bot y la lista de identidades vinculadas.
     * Nunca expone el bot_token ni el webhook_secret.
     */
    fastify.get('/api/organizations/:id/telegram', async (request, reply) => {
        const ctx = await authorizeTelegramConfig(request, reply, PERMISSION_KEYS.MANAGE_CREDENTIALS);
        if (!ctx) return;

        const [connection, identities] = await Promise.all([
            getTelegramConnectionStatus(ctx.organizationId),
            listTelegramIdentities(ctx.organizationId),
        ]);

        return reply.status(200).send({
            success: true,
            data: {
                connection,
                identities: identities.map((idRow) => ({
                    id: idRow.id,
                    organizationMemberId: idRow.organization_member_id,
                    userId: idRow.user_id,
                    telegramUserId: idRow.telegram_user_id,
                    telegramUsername: idRow.telegram_username,
                    telegramFirstName: idRow.telegram_first_name,
                    status: idRow.status,
                    linkedAt: idRow.linked_at,
                    revokedAt: idRow.revoked_at,
                    lastSeenAt: idRow.last_seen_at,
                })),
            },
        });
    });

    /**
     * POST /api/organizations/:id/telegram
     * Valida el Bot Token contra `getMe`, lo guarda en Vault y crea/actualiza la conexión.
     */
    fastify.post('/api/organizations/:id/telegram', async (request, reply) => {
        const ctx = await authorizeTelegramConfig(request, reply, PERMISSION_KEYS.MANAGE_CREDENTIALS);
        if (!ctx) return;

        const bodyResult = upsertTelegramConnectionBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            const firstIssue = bodyResult.error.issues[0]?.message || 'Cuerpo de petición inválido.';
            return reply.status(400).send({ success: false, error: firstIssue });
        }

        try {
            const status = await upsertTelegramConnection(ctx.organizationId, bodyResult.data.botToken);
            return reply.status(200).send({ success: true, data: status });
        } catch (err: unknown) {
            if (err instanceof TelegramConnectionError) {
                return reply.status(err.statusCode).send({ success: false, error: err.message });
            }
            request.log.error({ err, organizationId: ctx.organizationId }, '[OrganizationTelegram] Error guardando bot');
            return reply.status(500).send({
                success: false,
                error: 'No se pudo configurar el Bot de Telegram.',
            });
        }
    });

    /**
     * POST /api/organizations/:id/telegram/validate
     * Verifica el token guardado en Vault (o un token candidato enviado en el body) contra `getMe`.
     */
    fastify.post('/api/organizations/:id/telegram/validate', async (request, reply) => {
        const ctx = await authorizeTelegramConfig(request, reply, PERMISSION_KEYS.MANAGE_CREDENTIALS);
        if (!ctx) return;

        const bodyResult = validateTelegramTokenBodySchema.safeParse(request.body ?? {});
        if (!bodyResult.success) {
            const firstIssue = bodyResult.error.issues[0]?.message || 'Cuerpo de petición inválido.';
            return reply.status(400).send({ success: false, error: firstIssue });
        }

        const validation = await validateTelegramConnection(ctx.organizationId, bodyResult.data.botToken);
        if (!validation.valid) {
            return reply.status(400).send({
                success: false,
                valid: false,
                error: validation.error,
            });
        }

        return reply.status(200).send({
            success: true,
            valid: true,
            data: validation.bot,
        });
    });

    /**
     * POST /api/organizations/:id/telegram/webhook
     * Registra el webhook HTTPS en Telegram con el secret_token de la organización.
     */
    fastify.post('/api/organizations/:id/telegram/webhook', async (request, reply) => {
        const ctx = await authorizeTelegramConfig(request, reply, PERMISSION_KEYS.MANAGE_CREDENTIALS);
        if (!ctx) return;

        try {
            const status = await registerTelegramConnectionWebhook(ctx.organizationId);
            return reply.status(200).send({ success: true, data: status });
        } catch (err: unknown) {
            if (err instanceof TelegramConnectionError) {
                return reply.status(err.statusCode).send({ success: false, error: err.message });
            }
            request.log.error(
                { err, organizationId: ctx.organizationId },
                '[OrganizationTelegram] Error registrando webhook'
            );
            return reply.status(500).send({
                success: false,
                error: 'No se pudo registrar el webhook en Telegram.',
            });
        }
    });

    /**
     * DELETE /api/organizations/:id/telegram
     * Desconecta el Bot de Telegram de la organización y revoca las identidades activas.
     */
    fastify.delete('/api/organizations/:id/telegram', async (request, reply) => {
        const ctx = await authorizeTelegramConfig(request, reply, PERMISSION_KEYS.MANAGE_CREDENTIALS);
        if (!ctx) return;

        await deleteTelegramConnection(ctx.organizationId);
        return reply.status(200).send({ success: true });
    });

    /**
     * POST /api/organizations/:id/telegram/link-tokens
     * Genera un enlace efímero de un solo uso (`https://t.me/<bot>?start=<token>`)
     * para vincular la cuenta de Telegram del administrador autenticado.
     */
    fastify.post('/api/organizations/:id/telegram/link-tokens', async (request, reply) => {
        const ctx = await authorizeTelegramConfig(request, reply, PERMISSION_KEYS.USE_NL_REPORTS);
        if (!ctx) return;

        try {
            const link = await createTelegramLinkToken(ctx.organizationId, ctx.userId);
            return reply.status(201).send({
                success: true,
                data: link,
            });
        } catch (err: unknown) {
            if (err instanceof TelegramIdentityError) {
                return reply.status(err.statusCode).send({ success: false, error: err.message });
            }
            request.log.error(
                { err, organizationId: ctx.organizationId, userId: ctx.userId },
                '[OrganizationTelegram] Error generando link token'
            );
            return reply.status(500).send({
                success: false,
                error: 'No se pudo generar el enlace de vinculación.',
            });
        }
    });

    /**
     * DELETE /api/organizations/:id/telegram/identities/:identityId
     * Revoca una identidad de Telegram vinculada a la organización.
     */
    fastify.delete('/api/organizations/:id/telegram/identities/:identityId', async (request, reply) => {
        const paramsResult = telegramIdentityIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'Los parámetros "id" e "identityId" deben ser UUIDs válidos.',
            });
        }

        const ctx = await authorizeTelegramConfig(request, reply, PERMISSION_KEYS.MANAGE_CREDENTIALS);
        if (!ctx) return;

        const revoked = await revokeTelegramIdentity(ctx.organizationId, paramsResult.data.identityId);
        if (!revoked) {
            return reply.status(404).send({
                success: false,
                error: 'Identidad de Telegram no encontrada en esta organización.',
            });
        }

        return reply.status(200).send({ success: true });
    });
}

export default organizationTelegramRoutes;
