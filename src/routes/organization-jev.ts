import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuthenticatedUser } from '../lib/organization-auth.js';
import { getPermissionsForUser } from '../services/permission-service.js';
import { PERMISSION_KEYS } from '../types/permission-keys.js';
import {
    jevConfigBodySchema,
    jevConfigResponseSchema,
    jevValidateErrorResponseSchema,
    jevValidateSuccessResponseSchema,
} from '../schemas/jev.js';
import { organizationIdParamsSchema } from '../schemas/organization-onboarding.js';
import { getJevConfig, updateJevConfig, validateJevCredentials } from '../services/jev-config-service.js';

/**
 * Rutas de configuración BYOK de Jev (TypeSafe AI) vía OpenRouter. Aparte de
 * `/llm-config` porque Jev no redacta texto y no puede sustituir al LLM de
 * reportes y narrativas.
 *
 * La llave en sí se guarda vía el endpoint genérico
 * `POST /api/organizations/:id/credentials` (provider: 'jev'). Aquí solo vive
 * el modelo a usar y la validación en vivo de la llave contra OpenRouter.
 *
 * RBAC: `manage_credentials` cubre todo `/jev`, igual que `/llm`.
 */
export async function organizationJevRoutes(fastify: FastifyInstance) {
    async function authorizeForOrganization(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<{ organizationId: string } | null> {
        const paramsResult = organizationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
            return null;
        }

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const permissions = await getPermissionsForUser(paramsResult.data.id, auth.userId, auth.jwt);
        if (!permissions.has(PERMISSION_KEYS.MANAGE_CREDENTIALS)) {
            reply.status(403).send({
                success: false,
                error: 'Forbidden',
                code: 'PERMISSION_DENIED',
                message: `No tiene el permiso "${PERMISSION_KEYS.MANAGE_CREDENTIALS}" en esta organización, o no pertenece a ella.`,
                requiredPermission: PERMISSION_KEYS.MANAGE_CREDENTIALS,
            });
            return null;
        }

        return { organizationId: paramsResult.data.id };
    }

    /**
     * GET /api/organizations/:id/jev-config
     */
    fastify.get('/api/organizations/:id/jev-config', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const config = await getJevConfig(fastify, ctx.organizationId);
        return reply.status(200).send(jevConfigResponseSchema.parse({ success: true, data: config }));
    });

    /**
     * PATCH /api/organizations/:id/jev-config
     * Cambiar el modelo invalida cualquier validación previa.
     */
    fastify.patch('/api/organizations/:id/jev-config', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const bodyResult = jevConfigBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'Cuerpo de la petición inválido: se requiere "model" con la forma "autor/modelo" de OpenRouter.',
            });
        }

        const result = await updateJevConfig(fastify, ctx.organizationId, bodyResult.data);
        if (!result.success) {
            return reply.status(500).send(result);
        }

        const config = await getJevConfig(fastify, ctx.organizationId);
        return reply.status(200).send(jevConfigResponseSchema.parse({ success: true, data: config }));
    });

    /**
     * POST /api/organizations/:id/jev/validate
     * Verifica la llave de OpenRouter sin consumir tokens. Nunca expone el
     * error crudo del proveedor — solo un mensaje accionable.
     */
    fastify.post('/api/organizations/:id/jev/validate', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const result = await validateJevCredentials(fastify, ctx.organizationId);
        if (!result.success) {
            return reply
                .status(422)
                .send(jevValidateErrorResponseSchema.parse({ success: false, error: result.error, kind: result.kind }));
        }

        return reply
            .status(200)
            .send(jevValidateSuccessResponseSchema.parse({ success: true, data: { validatedAt: result.validatedAt } }));
    });
}

export default organizationJevRoutes;
