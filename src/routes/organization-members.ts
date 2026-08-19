import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuthenticatedUser } from '../lib/organization-auth.js';
import { getPermissionsForUser } from '../services/permission-service.js';
import { PERMISSION_KEYS } from '../types/permission-keys.js';
import {
    organizationIdParamsSchema,
    invitationParamsSchema,
    memberParamsSchema,
    createInvitationBodySchema,
    acceptInvitationBodySchema,
    changeMemberRoleBodySchema,
} from '../schemas/organization-members.js';
import {
    createInvitation,
    listPendingInvitations,
    revokeInvitation,
    acceptInvitation,
    listOrganizationMembers,
    changeMemberRole,
    deactivateMember,
    getSeatUsage,
} from '../services/invitation-service.js';

const RPC_ERROR_STATUS: Record<string, number> = {
    OWNER_INVITE_FORBIDDEN: 400,
    SEAT_LIMIT: 400,
    ALREADY_INVITED: 409,
    NOT_FOUND: 404,
    ALREADY_ACCEPTED: 409,
    ALREADY_REVOKED: 409,
    INVALID_TOKEN: 400,
    EMAIL_MISMATCH: 403,
    ALREADY_MEMBER: 409,
    CANNOT_CHANGE_OWN_ROLE: 403,
    ADMIN_CANNOT_MODIFY_OWNER: 403,
    ADMIN_CANNOT_PROMOTE_TO_OWNER: 403,
    LAST_OWNER: 409,
    CANNOT_REMOVE_SELF: 403,
};

function statusForErrorCode(errorCode: string | undefined): number {
    return (errorCode && RPC_ERROR_STATUS[errorCode]) || 400;
}

/**
 * Rutas de FASE C (docs/tasks/RBAC-permisos.md): invitaciones y gestión de
 * miembros. Toda ruta salvo `POST /invitations/accept` exige el permiso
 * `manage_users` (no basta con pertenecer a la organización) — un usuario
 * sin ese permiso recibe 403 antes de tocar ningún servicio.
 *
 * `:memberId` es el `user_id` del miembro (no el `id` de fila de
 * `organization_members`) — así el cliente puede referenciarlo directo
 * desde `GET /members`, que expone `user_id`.
 */
export async function organizationMembersRoutes(fastify: FastifyInstance) {
    async function authorizeManageUsers(
        request: FastifyRequest,
        reply: FastifyReply,
        organizationId: string
    ): Promise<{ userId: string; jwt: string } | null> {
        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const permissions = await getPermissionsForUser(organizationId, auth.userId, auth.jwt);
        if (!permissions.has(PERMISSION_KEYS.MANAGE_USERS)) {
            reply.status(403).send({
                success: false,
                error: 'Forbidden',
                code: 'PERMISSION_DENIED',
                message: `No tiene el permiso "${PERMISSION_KEYS.MANAGE_USERS}" en esta organización, o no pertenece a ella.`,
                requiredPermission: PERMISSION_KEYS.MANAGE_USERS,
            });
            return null;
        }
        return { userId: auth.userId, jwt: auth.jwt };
    }

    /**
     * POST /api/organizations/:id/invitations
     */
    fastify.post('/api/organizations/:id/invitations', async (request, reply) => {
        const paramsResult = organizationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
        }
        const { id: organizationId } = paramsResult.data;

        const auth = await authorizeManageUsers(request, reply, organizationId);
        if (!auth) return;

        const bodyResult = createInvitationBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'Cuerpo de la petición inválido: se requiere "email" válido y "role" (admin, member o viewer — no se puede invitar como owner).',
            });
        }

        const result = await createInvitation(organizationId, bodyResult.data.email, bodyResult.data.role as never, auth.userId);
        if (!result.success) {
            return reply.status(statusForErrorCode(result.errorCode)).send({ success: false, error: result.error, code: result.errorCode });
        }

        return reply.status(201).send({ success: true, data: result.data });
    });

    /**
     * GET /api/organizations/:id/invitations
     */
    fastify.get('/api/organizations/:id/invitations', async (request, reply) => {
        const paramsResult = organizationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
        }
        const { id: organizationId } = paramsResult.data;

        const auth = await authorizeManageUsers(request, reply, organizationId);
        if (!auth) return;

        try {
            const [invitations, seats] = await Promise.all([listPendingInvitations(organizationId), getSeatUsage(organizationId)]);
            return reply.send({ success: true, data: { invitations, seats } });
        } catch (err: unknown) {
            request.log.error({ err, organizationId }, '[OrganizationMembers] Error listando invitaciones');
            return reply.status(500).send({ success: false, error: 'No se pudieron listar las invitaciones.' });
        }
    });

    /**
     * DELETE /api/organizations/:id/invitations/:invId
     */
    fastify.delete('/api/organizations/:id/invitations/:invId', async (request, reply) => {
        const paramsResult = invitationParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'Los parámetros de ruta deben ser UUID válidos.' });
        }
        const { id: organizationId, invId } = paramsResult.data;

        const auth = await authorizeManageUsers(request, reply, organizationId);
        if (!auth) return;

        const result = await revokeInvitation(invId, auth.userId);
        if (!result.success) {
            return reply.status(statusForErrorCode(result.errorCode)).send({ success: false, error: result.error, code: result.errorCode });
        }
        return reply.send({ success: true });
    });

    /**
     * POST /api/invitations/accept
     * Sin membresía previa por diseño — un usuario recién invitado aún no
     * pertenece a ninguna organización. Solo exige sesión autenticada; el
     * email de esa sesión debe coincidir con el email invitado (lo verifica
     * accept_invitation en la misma transacción que crea la membresía).
     */
    fastify.post('/api/invitations/accept', async (request, reply) => {
        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;

        const bodyResult = acceptInvitationBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: se requiere "token".' });
        }

        const { data: userData, error: userError } = await fastify.supabaseAdmin.auth.admin.getUserById(auth.userId);
        if (userError || !userData.user?.email) {
            return reply.status(400).send({ success: false, error: 'No se pudo determinar el correo de la sesión actual.' });
        }

        const result = await acceptInvitation(bodyResult.data.token, auth.userId, userData.user.email);
        if (!result.success) {
            return reply.status(statusForErrorCode(result.errorCode)).send({ success: false, error: result.error, code: result.errorCode });
        }
        return reply.send({ success: true, data: result.data });
    });

    /**
     * GET /api/organizations/:id/members
     * Cualquier miembro puede ver la lista de su equipo — no se restringe a
     * manage_users (a diferencia de invitaciones/cambios de rol).
     */
    fastify.get('/api/organizations/:id/members', async (request, reply) => {
        const paramsResult = organizationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
        }
        const { id: organizationId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;

        const permissions = await getPermissionsForUser(organizationId, auth.userId, auth.jwt);
        if (permissions.size === 0) {
            return reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
        }

        try {
            const members = await listOrganizationMembers(organizationId);
            return reply.send({ success: true, data: members });
        } catch (err: unknown) {
            request.log.error({ err, organizationId }, '[OrganizationMembers] Error listando miembros');
            return reply.status(500).send({ success: false, error: 'No se pudieron listar los miembros.' });
        }
    });

    /**
     * PATCH /api/organizations/:id/members/:memberId
     */
    fastify.patch('/api/organizations/:id/members/:memberId', async (request, reply) => {
        const paramsResult = memberParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'Los parámetros de ruta deben ser UUID válidos.' });
        }
        const { id: organizationId, memberId } = paramsResult.data;

        const auth = await authorizeManageUsers(request, reply, organizationId);
        if (!auth) return;

        const bodyResult = changeMemberRoleBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: se requiere "role" válido.' });
        }

        const result = await changeMemberRole(organizationId, memberId, bodyResult.data.role as never, auth.userId);
        if (!result.success) {
            return reply.status(statusForErrorCode(result.errorCode)).send({ success: false, error: result.error, code: result.errorCode });
        }
        return reply.send({ success: true, data: result.data });
    });

    /**
     * DELETE /api/organizations/:id/members/:memberId
     */
    fastify.delete('/api/organizations/:id/members/:memberId', async (request, reply) => {
        const paramsResult = memberParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'Los parámetros de ruta deben ser UUID válidos.' });
        }
        const { id: organizationId, memberId } = paramsResult.data;

        const auth = await authorizeManageUsers(request, reply, organizationId);
        if (!auth) return;

        const result = await deactivateMember(organizationId, memberId, auth.userId);
        if (!result.success) {
            return reply.status(statusForErrorCode(result.errorCode)).send({ success: false, error: result.error, code: result.errorCode });
        }
        return reply.send({ success: true });
    });
}

export default organizationMembersRoutes;
