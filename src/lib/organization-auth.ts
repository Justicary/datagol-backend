import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export interface AuthenticatedUser {
    userId: string;
    jwt: string;
}

function extractBearerToken(request: FastifyRequest): string | null {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return null;
    }
    const token = header.substring(7).trim();
    return token || null;
}

/**
 * Extrae y valida el JWT `Authorization: Bearer <jwt>` de `routes/organization-onboarding.ts`.
 * Responde 401 y devuelve `null` si falta o es inválido — el llamador debe
 * hacer `return` inmediatamente en ese caso (la respuesta ya fue enviada).
 */
export async function requireAuthenticatedUser(
    fastify: FastifyInstance,
    request: FastifyRequest,
    reply: FastifyReply
): Promise<AuthenticatedUser | null> {
    const jwt = extractBearerToken(request);
    if (!jwt) {
        reply.status(401).send({ success: false, error: 'Se requiere un token de autenticación (Authorization: Bearer <jwt>).' });
        return null;
    }

    const { data, error } = await fastify.supabaseAdmin.auth.getUser(jwt);
    if (error || !data?.user) {
        reply.status(401).send({ success: false, error: 'Token de autenticación inválido o expirado.' });
        return null;
    }

    return { userId: data.user.id, jwt };
}

/**
 * Verifica pertenencia a una organización EXISTENTE haciendo un `SELECT` con
 * `fastify.supabaseUser(jwt)` (respeta RLS — la política `org_self_access`
 * deniega la fila si el usuario no es miembro). No reimplementa el chequeo
 * consultando `organization_members` directamente con `supabaseAdmin`: eso
 * bypasearía RLS y duplicaría una lógica que la base ya resuelve
 * (`auth_organization_ids()`), con riesgo de que ambas versiones diverjan.
 */
export async function requireOrganizationMembership(
    fastify: FastifyInstance,
    jwt: string,
    organizationId: string
): Promise<boolean> {
    const scopedClient = fastify.supabaseUser(jwt);
    const { data, error } = await scopedClient.from('organizations').select('id').eq('id', organizationId).maybeSingle();
    return !error && !!data;
}
