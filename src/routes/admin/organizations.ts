import { FastifyPluginAsync } from 'fastify';
import { supabaseAdmin } from '../../lib/supabase.js';
import { isPlatformAdmin } from '../../lib/platform-admin.js';
import { setOrganizationStatus, listOrganizationsForAdmin } from '../../services/organization-lifecycle.js';

interface StatusChangeBody {
    reason: string;
}

/**
 * Rutas administrativas de suspensión/reactivación de organizaciones.
 * docs/tasks/organization-suspension.md.
 */
export const adminOrganizationsRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', isPlatformAdmin);

    /**
     * GET /api/admin/organizations
     */
    fastify.get('/api/admin/organizations', async (_request, reply) => {
        try {
            const organizations = await listOrganizationsForAdmin();
            return reply.status(200).send({ organizations });
        } catch (err: any) {
            return reply.status(500).send({ error: 'InternalServerError', message: err.message });
        }
    });

    /**
     * POST /api/admin/organizations/:orgId/suspend
     */
    fastify.post<{ Params: { orgId: string }; Body: StatusChangeBody }>(
        '/api/admin/organizations/:orgId/suspend',
        async (request, reply) => {
            const { orgId } = request.params;
            const { reason } = request.body || {};

            if (!reason || typeof reason !== 'string' || reason.trim() === '') {
                return reply.status(400).send({ error: 'BadRequest', message: 'El campo "reason" es obligatorio.' });
            }

            const result = await setOrganizationStatus(orgId, 'suspended', reason);
            if (!result.success) {
                const statusCode = result.error?.includes('ya está en estado') ? 409 : 400;
                return reply.status(statusCode).send({ error: 'SuspendFailed', message: result.error });
            }

            const { data: org } = await supabaseAdmin
                .from('organizations')
                .select('id, status, suspended_reason, suspended_at')
                .eq('id', orgId)
                .single();

            return reply.status(200).send({
                message: `Organización '${orgId}' suspendida con éxito.`,
                organization: org,
            });
        }
    );

    /**
     * POST /api/admin/organizations/:orgId/reactivate
     */
    fastify.post<{ Params: { orgId: string }; Body: StatusChangeBody }>(
        '/api/admin/organizations/:orgId/reactivate',
        async (request, reply) => {
            const { orgId } = request.params;
            const { reason } = request.body || {};

            if (!reason || typeof reason !== 'string' || reason.trim() === '') {
                return reply.status(400).send({ error: 'BadRequest', message: 'El campo "reason" es obligatorio.' });
            }

            const result = await setOrganizationStatus(orgId, 'active', reason);
            if (!result.success) {
                const statusCode = result.error?.includes('ya está en estado') ? 409 : 400;
                return reply.status(statusCode).send({ error: 'ReactivateFailed', message: result.error });
            }

            const { data: org } = await supabaseAdmin
                .from('organizations')
                .select('id, status, suspended_reason, suspended_at')
                .eq('id', orgId)
                .single();

            return reply.status(200).send({
                message: `Organización '${orgId}' reactivada con éxito.`,
                organization: org,
            });
        }
    );
};

export default adminOrganizationsRoutes;
