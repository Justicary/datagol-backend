import { FastifyPluginAsync } from 'fastify';
import { isPlatformAdmin } from '../../lib/platform-admin.js';

/**
 * Fase C — GET /control/fleet y GET /control/revenue. Ambas leen
 * directamente las vistas ya definidas en `55_control_plane_datagol.sql`
 * (`v_fleet_health`, `v_recurring_revenue`) — no hay lógica de negocio que
 * duplicar aquí.
 */
export const controlFleetRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', isPlatformAdmin);

    fastify.get('/control/fleet', async (_request, reply) => {
        const { data, error } = await fastify.supabaseAdmin
            .from('v_fleet_health')
            .select('*')
            .order('dias_sin_latido', { ascending: false, nullsFirst: false });

        if (error) {
            return reply.status(500).send({ error: 'InternalServerError', message: error.message });
        }
        return reply.status(200).send({ data });
    });

    fastify.get('/control/revenue', async (_request, reply) => {
        const { data, error } = await fastify.supabaseAdmin.from('v_recurring_revenue').select('*');

        if (error) {
            return reply.status(500).send({ error: 'InternalServerError', message: error.message });
        }
        return reply.status(200).send({ data });
    });
};

export default controlFleetRoutes;
