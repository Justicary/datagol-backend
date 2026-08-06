import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { getOrganizationFeatures } from '../services/entitlements.js';

/**
 * Plugin de Fastify que inyecta `request.features` en cada petición
 * y provee el helper `requireFeature(featureKey)`.
 */
const entitlementsPluginCallback: FastifyPluginAsync = async (fastify) => {
    // Hook onRequest para resolver la organización e inyectar sus features
    fastify.addHook('onRequest', async (request: FastifyRequest) => {
        const orgId =
            (request.headers['x-organization-id'] as string) ||
            (request.headers['x-tenant-id'] as string) ||
            request.tenantId;

        if (orgId) {
            request.tenantId = orgId;
            request.features = await getOrganizationFeatures(orgId);
        } else {
            request.features = new Set<string>();
        }
    });
};

/**
 * Middleware/Helper para requerir una característica (feature) en un handler de Fastify.
 * Si la feature no está concedida en `request.features`, responde 403 con mensaje claro para el frontend.
 */
export function requireFeature(featureKey: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const features = request.features || new Set<string>();

        if (!features.has(featureKey)) {
            return reply.status(403).send({
                statusCode: 403,
                error: 'Forbidden',
                code: 'FEATURE_DISABLED',
                message: `La función '${featureKey}' no está habilitada para su organización. Contacte a soporte o actualice su plan para acceder a esta característica.`,
                requiredFeature: featureKey,
            });
        }
    };
}

export const entitlementsPlugin = fp(entitlementsPluginCallback, {
    name: 'entitlements-plugin',
    dependencies: ['supabase-plugin'],
});

export default entitlementsPlugin;
