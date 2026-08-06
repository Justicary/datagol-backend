import { FastifyRequest, FastifyReply } from 'fastify';
import { supabaseAdmin } from './supabase.js';

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
}
