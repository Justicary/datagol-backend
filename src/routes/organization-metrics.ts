import { FastifyInstance } from 'fastify';
import { requireAuthenticatedUser, requireOrganizationMembership } from '../lib/organization-auth.js';
import {
    organizationMetricsParamsSchema,
    organizationMetricsQuerySchema,
    organizationMetricsResponseSchema,
} from '../schemas/organization-metrics.js';

/**
 * GET /api/organizations/:id/metrics?from=&to=
 * Métricas por canal (leads.channel) consumidas por el dashboard de
 * datagol-frontend. Toda la agregación vive en
 * `public.get_organization_channel_metrics` (db/migrations/24_channel_metrics.sql)
 * — esta ruta solo autentica, valida el periodo y llama al RPC. Ver
 * docs/tasks/opus.md.
 */
export async function organizationMetricsRoutes(fastify: FastifyInstance) {
    fastify.get('/api/organizations/:id/metrics', async (request, reply) => {
        const paramsResult = organizationMetricsParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
        }
        const { id: organizationId } = paramsResult.data;

        const queryResult = organizationMetricsQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'Los parámetros de consulta "from" y "to" (fechas ISO 8601) son obligatorios.',
            });
        }

        const periodFrom = new Date(queryResult.data.from);
        const periodTo = new Date(queryResult.data.to);

        if (Number.isNaN(periodFrom.getTime()) || Number.isNaN(periodTo.getTime())) {
            return reply.status(400).send({ success: false, error: 'Los parámetros "from" y "to" deben ser fechas ISO 8601 válidas.' });
        }
        if (periodFrom >= periodTo) {
            return reply.status(400).send({ success: false, error: 'El parámetro "from" debe ser anterior a "to".' });
        }

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;

        const isMember = await requireOrganizationMembership(fastify, auth.jwt, organizationId);
        if (!isMember) {
            return reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
        }

        const { data, error } = await fastify.supabaseAdmin.rpc('get_organization_channel_metrics', {
            p_organization_id: organizationId,
            p_from: periodFrom.toISOString(),
            p_to: periodTo.toISOString(),
        });

        if (error) {
            request.log.error({ organizationId, err: error.message, msg: 'Error calculando métricas por canal' });
            return reply.status(500).send({ success: false, error: 'No se pudieron calcular las métricas.' });
        }

        return reply.send(organizationMetricsResponseSchema.parse(data));
    });
}

export default organizationMetricsRoutes;
