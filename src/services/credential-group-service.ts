import { supabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';

export interface CredentialGroupOwner {
    groupId: string;
    ownerOrganizationId: string;
}

interface CachedOwner {
    value: CredentialGroupOwner | null;
    expiresAt: number;
}

// Está en el camino crítico de getSecret()/setSecret() (AGENTS.md §3, p95 <
// 300ms en routes/tools/**): la resolución del owner del grupo no puede
// costar una consulta extra en cada tool call. Mismo TTL que secretCache en
// secret-service.ts.
const CACHE_TTL_MS = 60 * 1000;
const ownerCache = new Map<string, CachedOwner>();

/**
 * Resuelve la organización dueña del grupo de credenciales al que pertenece
 * `organizationId` (docs/tasks/catalogo-productos-grupos-cred.md, FASE B).
 * En un grupo de uno, `ownerOrganizationId === organizationId` — el mismo
 * comportamiento de antes de que existieran los grupos.
 *
 * Nunca lanza: si no se puede resolver (organización inexistente, sin grupo
 * — no debería pasar tras la Fase B.3 de la migración 57, pero el código no
 * confía en eso — o el grupo sin owner_organization_id), devuelve `null` y el
 * llamador decide cómo degradar. Mismo criterio de "nunca inventar, nunca
 * tronar" que rate-service.ts/webhook-verification.ts.
 */
export async function getCredentialGroupOwner(organizationId: string): Promise<CredentialGroupOwner | null> {
    if (!organizationId) {
        return null;
    }

    const now = Date.now();
    const cached = ownerCache.get(organizationId);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }

    const { data: org, error: orgError } = await supabaseAdmin
        .from('organizations')
        .select('credential_group_id')
        .eq('id', organizationId)
        .maybeSingle();

    if (orgError || !org || !org.credential_group_id) {
        logger.warn({ organizationId, err: orgError?.message }, '[CredentialGroupService] No se pudo resolver credential_group_id para la organización');
        ownerCache.set(organizationId, { value: null, expiresAt: now + CACHE_TTL_MS });
        return null;
    }

    const { data: group, error: groupError } = await supabaseAdmin
        .from('credential_groups')
        .select('id, owner_organization_id')
        .eq('id', org.credential_group_id)
        .maybeSingle();

    if (groupError || !group || !group.owner_organization_id) {
        logger.warn(
            { organizationId, groupId: org.credential_group_id, err: groupError?.message },
            '[CredentialGroupService] El grupo de credenciales no tiene owner_organization_id resuelto'
        );
        ownerCache.set(organizationId, { value: null, expiresAt: now + CACHE_TTL_MS });
        return null;
    }

    const resolved: CredentialGroupOwner = {
        groupId: group.id,
        ownerOrganizationId: group.owner_organization_id,
    };

    ownerCache.set(organizationId, { value: resolved, expiresAt: now + CACHE_TTL_MS });
    return resolved;
}

/**
 * Nombre de la organización dueña de un grupo — solo para mensajes de UI
 * ("esta credencial la administra <nombre>", B.2). Deliberadamente aparte de
 * `getCredentialGroupOwner`: esa función está en el camino crítico de
 * `getSecret`/`setSecret` y no necesita el nombre casi nunca, así que no vale
 * la pena cargarlo en cada resolución.
 */
export async function getOrganizationName(organizationId: string): Promise<string | null> {
    const { data, error } = await supabaseAdmin.from('organizations').select('name').eq('id', organizationId).maybeSingle();
    if (error || !data) return null;
    return data.name as string;
}

/**
 * `true` si `organizationId` es el owner de su propio grupo de credenciales
 * (incluye el caso trivial de grupo de uno). `false` si es un miembro no-owner
 * o si el grupo no se pudo resolver — nunca se asume ownership por defecto,
 * la ambigüedad se trata como "no autorizado" (mismo criterio de "denegar por
 * defecto" de AGENTS.md §16).
 */
export async function isCredentialGroupOwner(organizationId: string): Promise<boolean> {
    const owner = await getCredentialGroupOwner(organizationId);
    return owner !== null && owner.ownerOrganizationId === organizationId;
}

export function clearCredentialGroupOwnerCache(organizationId?: string): void {
    if (!organizationId) {
        ownerCache.clear();
        return;
    }
    ownerCache.delete(organizationId);
}
