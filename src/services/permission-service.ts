import { createSupabaseUserClient } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import type { PermissionKey } from '../types/permission-keys.js';

export interface PermissionsCacheItem {
    permissions: Set<string>;
    expiresAt: number;
}

const PERMISSIONS_CACHE_TTL_MS = 30 * 1000; // 30s TTL, mismo criterio que ENTITLEMENTS_CACHE_TTL_MS
const permissionsCache = new Map<string, PermissionsCacheItem>();

function cacheKey(organizationId: string, userId: string): string {
    return `${organizationId}:${userId}`;
}

/**
 * Resuelve el conjunto de permisos de un usuario en una organización.
 * Precedencia estricta (aplicada dentro de `has_permission()`,
 * db/migrations/45_RBAC_permisos.sql BLOQUE 4):
 *   invariante de owner → override de la organización → default del rol → negar
 *
 * `auth_permissions_in_org()` depende de `auth.uid()` dentro de Postgres —
 * a diferencia de `getOrganizationFeatures()` (entitlements.ts), que solo
 * necesita el organization_id, aquí hace falta el JWT del usuario para que
 * PostgREST fije `auth.uid()` en la sesión de la llamada RPC. Llamarlo con
 * `supabaseAdmin` (service_role) daría `auth.uid() IS NULL` y todo se
 * denegaría.
 *
 * Nunca lanza: si el RPC falla, deniega por defecto (conjunto vacío) —
 * mismo criterio de "respuesta degradada" de AGENTS.md §16.
 */
export async function getPermissionsForUser(
    organizationId: string,
    userId: string,
    userJwt: string
): Promise<Set<string>> {
    if (!organizationId || !userId) {
        return new Set();
    }

    const key = cacheKey(organizationId, userId);
    const now = Date.now();
    const cached = permissionsCache.get(key);
    if (cached && cached.expiresAt > now) {
        return cached.permissions;
    }

    const scopedClient = createSupabaseUserClient(userJwt);
    const { data, error } = await scopedClient.rpc('auth_permissions_in_org', { p_org_id: organizationId });

    if (error) {
        logger.warn({ err: error, organizationId, userId }, '[Permissions] Error resolviendo auth_permissions_in_org; se deniega por defecto');
        return new Set();
    }

    const permissions = new Set<string>((data ?? []).map((row: { permission_key: string }) => row.permission_key));

    permissionsCache.set(key, { permissions, expiresAt: now + PERMISSIONS_CACHE_TTL_MS });

    return permissions;
}

export function hasPermission(permissions: Set<string>, key: PermissionKey): boolean {
    return permissions.has(key);
}

/**
 * Invalidación explícita. Se llama tras cambiar un rol, aplicar/expirar un
 * override, o cualquier operación de FASE C/D que altere permisos
 * efectivos. Sin `userId`, limpia toda la organización (necesario porque un
 * cambio de rol o de override afecta a todos los miembros con ese rol, no
 * solo a quien hizo el cambio).
 */
export function clearPermissionsCache(organizationId?: string, userId?: string): void {
    if (!organizationId) {
        permissionsCache.clear();
        return;
    }
    if (userId) {
        permissionsCache.delete(cacheKey(organizationId, userId));
        return;
    }
    const prefix = `${organizationId}:`;
    for (const existingKey of permissionsCache.keys()) {
        if (existingKey.startsWith(prefix)) {
            permissionsCache.delete(existingKey);
        }
    }
}

/**
 * Restricción por columna de B.4 (docs/tasks/RBAC-permisos.md): RLS protege
 * filas, no columnas. `view_transcripts` se resuelve en la capa de API —
 * si el usuario no tiene el permiso, `transcript` y `summary` se OMITEN
 * (borrados, no anulados) de cada registro antes de serializar. Un campo
 * presente y nulo filtra su existencia; por eso se usa `delete`, no
 * `record.transcript = null`.
 */
export function omitProtectedTranscriptFields<T extends Record<string, unknown>>(
    record: T,
    canViewTranscripts: boolean
): T {
    if (canViewTranscripts) {
        return record;
    }
    const redacted = { ...record };
    delete redacted.transcript;
    delete redacted.summary;
    return redacted;
}

export function omitProtectedTranscriptFieldsFromList<T extends Record<string, unknown>>(
    records: readonly T[],
    canViewTranscripts: boolean
): T[] {
    return records.map((record) => omitProtectedTranscriptFields(record, canViewTranscripts));
}
