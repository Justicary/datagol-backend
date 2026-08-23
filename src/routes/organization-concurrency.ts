import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuthenticatedUser } from '../lib/organization-auth.js';
import { getPermissionsForUser } from '../services/permission-service.js';
import { PERMISSION_KEYS } from '../types/permission-keys.js';

interface OrganizationParams {
    id: string;
}

/**
 * GET /api/organizations/:id/concurrency (docs/tasks/catalogo-productos-grupos-cred.md,
 * FASE B.4): expone `v_concurrency_allocation` (db/migrations/56_catalogo_productos.sql
 * BLOQUE 12) para el grupo de credenciales de la organización que consulta.
 *
 * `v_concurrency_allocation` es `security_invoker`, pero esta ruta usa
 * `supabaseAdmin` (service_role bypasea RLS) y valida pertenencia
 * explícitamente — AGENTS.md §16: "toda consulta con supabaseAdmin debe
 * verificar permiso y pertenencia al catálogo/organización explícitamente".
 */
export const organizationConcurrencyRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/api/organizations/:id/concurrency', async (request: FastifyRequest<{ Params: OrganizationParams }>, reply: FastifyReply) => {
        const { id: organizationId } = request.params;
        if (!organizationId) {
            return reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" es obligatorio.' });
        }

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;

        const permissions = await getPermissionsForUser(organizationId, auth.userId, auth.jwt);
        if (!permissions.has(PERMISSION_KEYS.CONFIGURE_AGENT)) {
            return reply.status(403).send({
                success: false,
                error: 'Forbidden',
                code: 'PERMISSION_DENIED',
                message: `No tiene el permiso "${PERMISSION_KEYS.CONFIGURE_AGENT}" en esta organización, o no pertenece a ella.`,
                requiredPermission: PERMISSION_KEYS.CONFIGURE_AGENT,
            });
        }

        const { data: org, error: orgError } = await fastify.supabaseAdmin
            .from('organizations')
            .select('credential_group_id')
            .eq('id', organizationId)
            .maybeSingle();

        if (orgError || !org || !org.credential_group_id) {
            return reply.status(404).send({ success: false, error: 'No se pudo resolver el grupo de credenciales de esta organización.' });
        }

        const { data: allocation, error: allocationError } = await fastify.supabaseAdmin
            .from('v_concurrency_allocation')
            .select('credential_group_id, grupo, plan, pozo_total, cuotas_asignadas, sin_asignar, organizaciones')
            .eq('credential_group_id', org.credential_group_id)
            .maybeSingle();

        if (allocationError) {
            request.log.error({ organizationId, err: allocationError.message, msg: 'Error consultando v_concurrency_allocation' });
            return reply.status(500).send({ success: false, error: 'No se pudo consultar la asignación de concurrencia.' });
        }

        return reply.status(200).send({ success: true, data: allocation ?? null });
    });
};

export default organizationConcurrencyRoutes;
