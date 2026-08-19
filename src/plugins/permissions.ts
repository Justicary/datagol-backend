import { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { requireAuthenticatedUser } from '../lib/organization-auth.js';
import { getPermissionsForUser } from '../services/permission-service.js';
import type { PermissionKey } from '../types/permission-keys.js';

export interface RequirePermissionOptions {
    /** Nombre del parámetro de ruta que trae el organization_id. Por defecto 'id' — convención ya usada en todas las rutas de organización de este repo. */
    paramName?: string;
}

/**
 * Helper de FASE B.2 (docs/tasks/RBAC-permisos.md): factory de `preHandler`
 * que autentica, resuelve permisos vía `getPermissionsForUser()` (B.1) y
 * rechaza con 403 si falta el permiso pedido. Decora `request.permissions`
 * y `request.authUser` para que el handler no vuelva a autenticar ni a
 * resolver permisos.
 *
 * Un usuario que no es miembro de la organización recibe un conjunto de
 * permisos vacío (auth_permissions_in_org() no devuelve filas) — el mismo
 * 403 cubre "no soy miembro" y "soy miembro pero sin este permiso", así
 * que este helper reemplaza a `requireOrganizationMembership` allí donde
 * se use.
 *
 * No se implementa como hook `onRequest` global (a diferencia de
 * `entitlementsPlugin`) porque hace falta el JWT del usuario, ya resuelto
 * por `requireAuthenticatedUser`, y el organization_id de `request.params`,
 * que Fastify solo tiene poblado en preHandler, no en onRequest.
 */
export function requirePermission(
    fastify: FastifyInstance,
    key: PermissionKey,
    options: RequirePermissionOptions = {}
): preHandlerHookHandler {
    const paramName = options.paramName ?? 'id';

    return async (request: FastifyRequest, reply: FastifyReply) => {
        const params = request.params as Record<string, string>;
        const organizationId = params?.[paramName];

        if (!organizationId) {
            return reply.status(400).send({
                success: false,
                error: `El parámetro de ruta "${paramName}" es obligatorio.`,
            });
        }

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return; // requireAuthenticatedUser ya envió la respuesta 401

        const permissions = await getPermissionsForUser(organizationId, auth.userId, auth.jwt);
        request.permissions = permissions;
        request.authUser = auth;

        if (!permissions.has(key)) {
            return reply.status(403).send({
                success: false,
                error: 'Forbidden',
                code: 'PERMISSION_DENIED',
                message: `No tiene el permiso "${key}" en esta organización. Pídale a un administrador que se lo conceda o contacte a soporte.`,
                requiredPermission: key,
            });
        }
    };
}
