import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
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
async function authorizeForOrganization(
    fastify: FastifyInstance,
    request: FastifyRequest,
    reply: FastifyReply
): Promise<{ jwt: string; organizationId: string } | null> {
    const paramsResult = organizationMetricsParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
        reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
        return null;
    }
    const { id: organizationId } = paramsResult.data;

    const auth = await requireAuthenticatedUser(fastify, request, reply);
    if (!auth) return null;

    const isMember = await requireOrganizationMembership(fastify, auth.jwt, organizationId);
    if (!isMember) {
        reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
        return null;
    }

    return { jwt: auth.jwt, organizationId };
}

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

    /**
     * GET /api/organizations/:id/business-results
     * Expone v_resultado_negocio (docs/tasks/asistencia-valor de cierre.md,
     * C.2) tal cual — la regla de honestidad ("toda cifra de valor debe
     * reportar cuántos cierres tienen monto y cuántos no") ya la resuelve la
     * vista misma: cada fila trae `clientes_cerrados` y `cierres_con_monto`
     * juntos, así que no hay ningún promedio calculado aparte que pudiera
     * esconder ese contexto.
     */
    fastify.get('/api/organizations/:id/business-results', async (request, reply) => {
        const ctx = await authorizeForOrganization(fastify, request, reply);
        if (!ctx) return;

        const scopedClient = fastify.supabaseUser(ctx.jwt);
        const { data, error } = await scopedClient
            .from('v_resultado_negocio')
            .select('*')
            .eq('organization_id', ctx.organizationId)
            .order('mes', { ascending: false });

        if (error) {
            request.log.error({ organizationId: ctx.organizationId, err: error.message, msg: 'Error consultando v_resultado_negocio' });
            return reply.status(500).send({ success: false, error: 'No se pudieron calcular los resultados de negocio.' });
        }

        return reply.send({ success: true, data: data ?? [] });
    });

    /**
     * GET /api/organizations/:id/appointment-compliance
     * Expone v_cumplimiento_citas (C.2/B): agendadas vs. asistidas/no
     * asistidas/canceladas/sin marcar, por semana.
     */
    fastify.get('/api/organizations/:id/appointment-compliance', async (request, reply) => {
        const ctx = await authorizeForOrganization(fastify, request, reply);
        if (!ctx) return;

        const scopedClient = fastify.supabaseUser(ctx.jwt);
        const { data, error } = await scopedClient
            .from('v_cumplimiento_citas')
            .select('*')
            .eq('organization_id', ctx.organizationId)
            .order('semana', { ascending: false });

        if (error) {
            request.log.error({ organizationId: ctx.organizationId, err: error.message, msg: 'Error consultando v_cumplimiento_citas' });
            return reply.status(500).send({ success: false, error: 'No se pudo calcular el cumplimiento de citas.' });
        }

        return reply.send({ success: true, data: data ?? [] });
    });

    /**
     * GET /api/organizations/:id/lead-attribution
     * Expone v_atribucion_origen (D.3) — los registros sin dato llegan como
     * `sin_dato` (ya resuelto por la vista vía COALESCE), nunca se ocultan
     * ni se reparten proporcionalmente entre los orígenes conocidos.
     */
    fastify.get('/api/organizations/:id/lead-attribution', async (request, reply) => {
        const ctx = await authorizeForOrganization(fastify, request, reply);
        if (!ctx) return;

        const scopedClient = fastify.supabaseUser(ctx.jwt);
        const { data, error } = await scopedClient
            .from('v_atribucion_origen')
            .select('*')
            .eq('organization_id', ctx.organizationId)
            .order('prospectos', { ascending: false });

        if (error) {
            request.log.error({ organizationId: ctx.organizationId, err: error.message, msg: 'Error consultando v_atribucion_origen' });
            return reply.status(500).send({ success: false, error: 'No se pudo calcular la atribución de origen.' });
        }

        return reply.send({ success: true, data: data ?? [] });
    });
}

export default organizationMetricsRoutes;
