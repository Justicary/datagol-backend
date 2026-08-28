import { FastifyRequest, FastifyReply } from 'fastify';
import { supabaseAdmin } from './supabase.js';
import { verifyAdminSession } from './admin-session.js';

/**
 * Middleware para verificar si el usuario llamador es Administrador de la Plataforma.
 * Compartido por todas las rutas bajo `routes/admin/**`.
 */
export async function isPlatformAdmin(request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;
    const isLocalDevAdmin = request.headers['x-platform-admin'] === 'true';

    if (isLocalDevAdmin) {
        return;
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({
            statusCode: 401,
            error: 'Unauthorized',
            message: 'Se requiere token de autenticación para acceder a rutas administrativas.',
        });
    }

    const token = authHeader.substring(7);

    // Pasaporte de superadmin delegado a api.datagol.net
    // (docs/tasks — SSO delegado): sesión local emitida por ESTA
    // instalación tras verificar un pase (routes/admin/sso.ts). Verificación
    // 100% local (HS256, ADMIN_SESSION_SECRET propio de esta instalación),
    // nunca llama a Supabase Auth. Si el token no es una sesión de este
    // tipo, se sigue con el camino de Supabase Auth de siempre — nunca se
    // quita el camino existente, solo se añade uno nuevo.
    const adminSession = await verifyAdminSession(token);
    if (adminSession.valid) {
        request.platformAdminEmail = adminSession.email;
        return;
    }

    // Verificar el usuario con Supabase Auth
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
        return reply.status(401).send({
            statusCode: 401,
            error: 'Unauthorized',
            message: 'Token de autenticación inválido o expirado.',
        });
    }

    // Verificar en organization_members si tiene rol superadmin / platform_admin
    const { data: member } = await supabaseAdmin
        .from('organization_members')
        .select('role')
        .eq('user_id', user.id)
        .eq('role', 'platform_admin')
        .maybeSingle();

    const isAppMetadataAdmin = user.app_metadata?.is_platform_admin === true;

    if (!member && !isAppMetadataAdmin) {
        return reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: 'Acceso denegado. Se requieren privilegios de Administrador de Plataforma.',
        });
    }

    // Expuesto para que rutas admin/** que distinguen nivel (ej.
    // routes/admin/permissions.ts, RBAC FASE D: "el nivel support es de
    // solo lectura") puedan consultar platform_admins.level sin volver a
    // autenticar. No se resuelve el nivel aquí mismo para no acoplar este
    // guard genérico a una tabla que la mayoría de rutas admin/** no usa.
    request.platformAdminUserId = user.id;
    request.platformAdminEmail = user.email ?? undefined;
}

/**
 * Restringe una ruta admin/** de escritura al nivel `admin` de
 * `platform_admins.level` — RBAC FASE D (docs/tasks/RBAC-permisos.md):
 * "Solo is_platform_admin(). El nivel support es de solo lectura."
 * Se usa DESPUÉS de `isPlatformAdmin` (necesita `request.platformAdminUserId`).
 *
 * Sin fila en `platform_admins` para el usuario (ej. un superadmin marcado
 * solo por `app_metadata.is_platform_admin`, o el bypass local
 * `x-platform-admin: true` sin `platformAdminUserId`) se trata como acceso
 * completo por defecto — la tabla `platform_admins.level` es
 * específicamente para RESTRINGIR a quienes se marcan `support`, no un
 * requisito para todo superadmin existente.
 */
export async function requireFullPlatformAdmin(request: FastifyRequest, reply: FastifyReply) {
    const userId = request.platformAdminUserId;
    if (!userId) return;

    const { data } = await supabaseAdmin.from('platform_admins').select('level').eq('user_id', userId).maybeSingle();

    if (data?.level === 'support') {
        return reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: 'Los administradores de nivel "support" tienen acceso de solo lectura en esta consola. Esta acción requiere nivel "admin".',
        });
    }
}
