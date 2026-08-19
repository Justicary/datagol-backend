import { FastifyPluginAsync } from 'fastify';
import { supabaseAdmin } from '../../lib/supabase.js';
import { isPlatformAdmin, requireFullPlatformAdmin } from '../../lib/platform-admin.js';
import { clearPermissionsCache } from '../../services/permission-service.js';
import { ALL_ORGANIZATION_ROLES, ORGANIZATION_ROLES } from '../../types/organization-roles.js';
import { isSensitivePermission, PERMISSION_KEYS } from '../../types/permission-keys.js';

interface OrgParams {
    id: string;
}

interface OverrideBody {
    role: string;
    permission_key: string;
    enabled: boolean;
    reason: string;
    expires_at?: string | null;
    confirm?: boolean;
}

/**
 * Consola del superadmin para el mapa de permisos por organización — RBAC
 * FASE D (docs/tasks/RBAC-permisos.md). Solo `is_platform_admin()`
 * (mismo hook que routes/admin/features.ts); las mutaciones además exigen
 * nivel `admin` de `platform_admins.level` (requireFullPlatformAdmin) — el
 * nivel `support` es de solo lectura.
 */
export const adminPermissionsRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', isPlatformAdmin);

    /**
     * GET /api/admin/permissions
     * Catálogo completo: permisos + mapa por defecto de rol→permiso.
     */
    fastify.get('/api/admin/permissions', async (request, reply) => {
        const { data: permissions, error: permErr } = await supabaseAdmin
            .from('permissions')
            .select('key, name, description, category, is_sensitive, sort_order')
            .order('sort_order', { ascending: true });
        if (permErr) {
            return reply.status(500).send({ success: false, error: permErr.message });
        }

        const { data: roleDefaults, error: rdErr } = await supabaseAdmin
            .from('role_permissions')
            .select('role, permission_key, enabled');
        if (rdErr) {
            return reply.status(500).send({ success: false, error: rdErr.message });
        }

        const defaultsByRole: Record<string, string[]> = {};
        for (const role of ALL_ORGANIZATION_ROLES) defaultsByRole[role] = [];
        for (const row of roleDefaults ?? []) {
            if (row.enabled) defaultsByRole[row.role]?.push(row.permission_key);
        }

        return reply.send({ success: true, data: { permissions: permissions ?? [], roleDefaults: defaultsByRole } });
    });

    /**
     * GET /api/admin/organizations/:id/permissions
     * Mapa efectivo por rol: default (role_permissions) + override vigente
     * (organization_role_permissions, no expirado) con origen explícito.
     * No reutiliza has_permission() porque esa función resuelve el permiso
     * del USUARIO QUE LLAMA (auth.uid()), no de un rol arbitrario — aquí se
     * necesita el mapa completo para los 4 roles a la vez.
     */
    fastify.get<{ Params: OrgParams }>('/api/admin/organizations/:id/permissions', async (request, reply) => {
        const { id: organizationId } = request.params;

        const { data: permissions, error: permErr } = await supabaseAdmin
            .from('permissions')
            .select('key, category, is_sensitive')
            .order('sort_order', { ascending: true });
        if (permErr) {
            return reply.status(500).send({ success: false, error: permErr.message });
        }

        const { data: roleDefaults, error: rdErr } = await supabaseAdmin
            .from('role_permissions')
            .select('role, permission_key, enabled');
        if (rdErr) {
            return reply.status(500).send({ success: false, error: rdErr.message });
        }

        const { data: overrides, error: ovErr } = await supabaseAdmin
            .from('organization_role_permissions')
            .select('role, permission_key, enabled, reason, expires_at, granted_by, created_at')
            .eq('organization_id', organizationId);
        if (ovErr) {
            return reply.status(500).send({ success: false, error: ovErr.message });
        }

        const defaultMap = new Map<string, boolean>();
        for (const row of roleDefaults ?? []) defaultMap.set(`${row.role}:${row.permission_key}`, row.enabled);

        const now = Date.now();
        const overrideMap = new Map<string, (typeof overrides)[number]>();
        for (const ov of overrides ?? []) {
            const isExpired = ov.expires_at ? new Date(ov.expires_at).getTime() <= now : false;
            if (!isExpired) overrideMap.set(`${ov.role}:${ov.permission_key}`, ov);
        }

        const rolesMap: Record<string, Array<Record<string, unknown>>> = {};
        for (const role of ALL_ORGANIZATION_ROLES) {
            rolesMap[role] = (permissions ?? []).map((perm) => {
                const key = `${role}:${perm.key}`;
                const override = overrideMap.get(key);
                const defaultEnabled = defaultMap.get(key) ?? false;

                // Invariante de owner (migración 45, has_permission()): el
                // owner nunca pierde manage_users/change_plan, sin importar
                // el override — se refleja en el mapa efectivo para que el
                // superadmin no se confunda viendo "denegado" cuando en
                // runtime siempre se concede.
                const ownerInvariant =
                    role === ORGANIZATION_ROLES.OWNER && (perm.key === PERMISSION_KEYS.MANAGE_USERS || perm.key === PERMISSION_KEYS.CHANGE_PLAN);

                const effective = ownerInvariant ? true : (override?.enabled ?? defaultEnabled);
                const origin = ownerInvariant ? 'owner_invariant' : override ? (override.enabled ? 'override_grant' : 'override_deny') : 'default';

                return {
                    permissionKey: perm.key,
                    category: perm.category,
                    isSensitive: perm.is_sensitive,
                    defaultEnabled,
                    effective,
                    origin,
                    override: override ?? null,
                };
            });
        }

        return reply.send({ success: true, data: { organizationId, roles: rolesMap } });
    });

    /**
     * PATCH /api/admin/organizations/:id/permissions
     * `reason` obligatorio. Permisos `is_sensitive` exigen `confirm: true`
     * explícito en el payload (evita el clic accidental que abre
     * credenciales a un viewer). Solo nivel `admin` (requireFullPlatformAdmin).
     */
    fastify.patch<{ Params: OrgParams; Body: OverrideBody }>(
        '/api/admin/organizations/:id/permissions',
        { preHandler: requireFullPlatformAdmin },
        async (request, reply) => {
            const { id: organizationId } = request.params;
            const { role, permission_key, enabled, reason, expires_at, confirm } = request.body || {};

            if (!role || !(ALL_ORGANIZATION_ROLES as readonly string[]).includes(role)) {
                return reply.status(400).send({ success: false, error: 'El campo "role" debe ser uno de: owner, admin, member, viewer.' });
            }
            if (!permission_key || typeof permission_key !== 'string') {
                return reply.status(400).send({ success: false, error: 'El campo "permission_key" es obligatorio.' });
            }
            if (typeof enabled !== 'boolean') {
                return reply.status(400).send({ success: false, error: 'El campo "enabled" (boolean) es obligatorio.' });
            }
            if (!reason || typeof reason !== 'string' || reason.trim() === '') {
                return reply.status(400).send({ success: false, error: 'El campo "reason" es obligatorio.' });
            }
            if (isSensitivePermission(permission_key) && confirm !== true) {
                return reply.status(400).send({
                    success: false,
                    error: 'BadRequest',
                    message: `"${permission_key}" es un permiso sensible. Se requiere confirmación explícita: envíe "confirm": true en el cuerpo de la petición.`,
                    code: 'CONFIRMATION_REQUIRED',
                });
            }

            const { data, error } = await supabaseAdmin.rpc('apply_permission_override', {
                p_org_id: organizationId,
                p_role: role,
                p_permission_key: permission_key,
                p_enabled: enabled,
                p_reason: reason.trim(),
                p_expires_at: expires_at ?? null,
                p_actor_id: request.platformAdminUserId ?? null,
            });

            if (error) {
                request.log.error({ err: error, organizationId }, '[AdminPermissions] Error inesperado en apply_permission_override');
                return reply.status(500).send({ success: false, error: 'No se pudo aplicar el override.' });
            }

            const result = data as { success: boolean; error_code?: string; message?: string };
            if (!result.success) {
                return reply.status(400).send({ success: false, error: result.message, code: result.error_code });
            }

            clearPermissionsCache(organizationId);

            return reply.send({ success: true });
        }
    );

    /**
     * GET /api/admin/organizations/:id/permissions/audit
     */
    fastify.get<{ Params: OrgParams }>('/api/admin/organizations/:id/permissions/audit', async (request, reply) => {
        const { id: organizationId } = request.params;

        const { data, error } = await supabaseAdmin
            .from('permission_audit_log')
            .select('*')
            .eq('organization_id', organizationId)
            .order('created_at', { ascending: false });

        if (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }

        return reply.send({ success: true, data: data ?? [] });
    });
};

export default adminPermissionsRoutes;
