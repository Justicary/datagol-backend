import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuthenticatedUser } from '../lib/organization-auth.js';
import { getPermissionsForUser } from '../services/permission-service.js';
import { PERMISSION_KEYS } from '../types/permission-keys.js';
import { llmConfigBodySchema, llmConfigResponseSchema } from '../schemas/llm.js';
import { organizationIdParamsSchema } from '../schemas/organization-onboarding.js';
import { getLlmConfig, updateLlmConfig, validateLlmCredentials } from '../services/llm-config-service.js';

/**
 * Rutas de configuración BYOK de LLM (docs/tasks/reportes-semanales.md, Fase A).
 * El valor de la llave en sí se guarda vía el endpoint genérico
 * `POST /api/organizations/:id/credentials` (provider: 'llm') — aquí solo
 * vive lo específico de LLM: qué proveedor/modelo usar, y la validación en
 * vivo contra el proveedor.
 *
 * RBAC B.5 (docs/tasks/RBAC-permisos.md): `manage_credentials` cubre todo
 * `/llm` — incluido el GET, porque revela qué proveedor/modelo BYOK usa la
 * organización.
 */
export async function organizationLlmRoutes(fastify: FastifyInstance) {
    async function authorizeForOrganization(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<{ userId: string; jwt: string; organizationId: string } | null> {
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

        return { userId: auth.userId, jwt: auth.jwt, organizationId: paramsResult.data.id };
    }

    /**
     * GET /api/organizations/:id/llm-config
     */
    fastify.get('/api/organizations/:id/llm-config', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const config = await getLlmConfig(fastify, ctx.organizationId);
        return reply.status(200).send(llmConfigResponseSchema.parse({ success: true, data: config }));
    });

    /**
     * PATCH /api/organizations/:id/llm-config
     * Cambiar la configuración invalida cualquier validación previa.
     */
    fastify.patch('/api/organizations/:id/llm-config', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const bodyResult = llmConfigBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: se requiere "provider" y "model".' });
        }

        const result = await updateLlmConfig(fastify, ctx.organizationId, bodyResult.data);
        if (!result.success) {
            return reply.status(500).send(result);
        }

        const config = await getLlmConfig(fastify, ctx.organizationId);
        return reply.status(200).send(llmConfigResponseSchema.parse({ success: true, data: config }));
    });

    /**
     * POST /api/organizations/:id/llm/validate
     * Llamada real y barata al proveedor configurado. Nunca expone el error
     * crudo del proveedor — solo un mensaje accionable.
     */
    fastify.post('/api/organizations/:id/llm/validate', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const result = await validateLlmCredentials(fastify, ctx.organizationId);
        if (!result.success) {
            return reply.status(422).send({ success: false, error: result.error, kind: result.kind });
        }

        return reply.status(200).send({ success: true, data: { validatedAt: result.validatedAt } });
    });
}

export default organizationLlmRoutes;
