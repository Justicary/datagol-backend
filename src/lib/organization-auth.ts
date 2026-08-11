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

/**
 * Verifica que el usuario tenga uno de los roles indicados en
 * `organization_members` para esta organización — para acciones que exigen
 * más que pertenencia (ej. `merge_contacts`, docs/tasks/opus.md Fase E:
 * "solo por un rol admin u owner"). Usa `fastify.supabaseUser(jwt)` (RLS),
 * mismo criterio que `requireOrganizationMembership`.
 *
 * `userId` se filtra explícitamente: la policy `members_self_access` de
 * `organization_members` da SELECT sobre TODAS las filas de una
 * organización a la que el usuario pertenece (para que el dashboard pueda
 * listar al equipo), no solo la fila propia — sin el filtro por
 * `user_id`, `.maybeSingle()` podría devolver el rol de otro miembro
 * cualquiera de esa organización.
 */
export async function requireOrganizationRole(
    fastify: FastifyInstance,
    jwt: string,
    organizationId: string,
    userId: string,
    allowedRoles: readonly string[]
): Promise<boolean> {
    const scopedClient = fastify.supabaseUser(jwt);
    const { data, error } = await scopedClient
        .from('organization_members')
        .select('role')
        .eq('organization_id', organizationId)
        .eq('user_id', userId)
        .maybeSingle();
    return !error && !!data && allowedRoles.includes(data.role);
}
