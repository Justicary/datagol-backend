import { FastifyPluginAsync } from 'fastify';
import { isPlatformAdmin } from '../../lib/platform-admin.js';
import { getUsageReconciliation } from '../../services/reconciliation-service.js';

interface ReconciliationParams {
    orgId: string;
}

interface ReconciliationQuery {
    from?: string;
    to?: string;
}

/**
 * Fase 3.3 — Endpoint administrativo de conciliación de metering.
 */
export const adminMeteringRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', isPlatformAdmin);

    /**
     * GET /api/admin/metering/organization/:orgId/reconciliation?from=&to=
     * Agrega el consumo interno registrado en usage_events para un periodo,
     * para cotejarlo contra la factura real del proveedor.
     */
    fastify.get<{ Params: ReconciliationParams; Querystring: ReconciliationQuery }>(
        '/api/admin/metering/organization/:orgId/reconciliation',
        async (request, reply) => {
            const { orgId } = request.params;
            const { from, to } = request.query;

            if (!from || !to) {
                return reply.status(400).send({
                    error: 'BadRequest',
                    message: 'Los parámetros de consulta "from" y "to" (fechas ISO 8601) son obligatorios.',
                });
            }

            const periodFrom = new Date(from);
            const periodTo = new Date(to);

            if (Number.isNaN(periodFrom.getTime()) || Number.isNaN(periodTo.getTime())) {
                return reply.status(400).send({
                    error: 'BadRequest',
                    message: 'Los parámetros "from" y "to" deben ser fechas ISO 8601 válidas.',
                });
            }

            if (periodFrom >= periodTo) {
                return reply.status(400).send({
                    error: 'BadRequest',
                    message: 'El parámetro "from" debe ser anterior a "to".',
                });
            }

            try {
                const report = await getUsageReconciliation(fastify, orgId, periodFrom, periodTo);
                return reply.send(report);
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    );
};

export default adminMeteringRoutes;
