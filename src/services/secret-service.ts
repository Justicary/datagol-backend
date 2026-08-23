import pg from 'pg';
import { supabaseAdmin } from '../lib/supabase.js';
import { validateEnv } from '../config/env.js';
import { parseDatabaseUrl } from '../lib/database-url.js';
import { logger } from '../lib/logger.js';
import { getCredentialGroupOwner } from './credential-group-service.js';
import type { SecretKey } from '../types/secret-keys.js';

interface CachedSecret {
    value: string;
    expiresAt: number;
}

const CACHE_TTL_MS = 60 * 1000; // 60s TTL
const secretCache = new Map<string, CachedSecret>();

let poolInstance: pg.Pool | null = null;

function getPgPool(): pg.Pool {
    if (poolInstance) return poolInstance;

    const env = validateEnv();
    const config = parseDatabaseUrl(env.DATABASE_URL);
    poolInstance = new pg.Pool({
        ...config,
        max: 5,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000,
    });

    return poolInstance;
}

function getCacheKey(organizationId: string, secretKey: string): string {
    return `${organizationId}:${secretKey}`;
}

/**
 * Resuelve la organización contra la que realmente vive el secreto
 * compartido (docs/tasks/catalogo-productos-grupos-cred.md, FASE B.1): la
 * dueña del grupo de credenciales de `organizationId`, no `organizationId`
 * en sí. En un grupo de uno son la misma organización — comportamiento
 * idéntico al de antes de que existieran los grupos.
 *
 * Nunca lanza ni bloquea: si el grupo no se puede resolver (organización
 * sin `credential_group_id`, dato aún no retro-llenado, etc.), degrada a
 * `organizationId` tal cual — mismo criterio de "nunca romper el camino
 * existente por una pieza nueva que aún no aplica" de toda la Fase B.
 */
async function resolveSecretOwnerId(organizationId: string): Promise<string> {
    const owner = await getCredentialGroupOwner(organizationId);
    return owner?.ownerOrganizationId ?? organizationId;
}

/**
 * Resuelve un secreto desde `organization_secrets` -> Supabase Vault (`vault.decrypted_secrets`).
 */
export async function getSecret(
    organizationId: string,
    secretKey: SecretKey
): Promise<string | null> {
    if (!organizationId || !secretKey) {
        return null;
    }

    const ownerOrganizationId = await resolveSecretOwnerId(organizationId);

    const cacheKey = getCacheKey(ownerOrganizationId, secretKey);
    const now = Date.now();
    const cached = secretCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
        return cached.value;
    }

    try {
        // 1. Obtener la referencia en organization_secrets (de la organización
        // DUEÑA del grupo, no de la que preguntó).
        const { data: orgSecret, error: orgSecErr } = await supabaseAdmin
            .from('organization_secrets')
            .select('vault_secret_id')
            .eq('organization_id', ownerOrganizationId)
            .eq('secret_key', secretKey)
            .maybeSingle();

        if (orgSecErr || !orgSecret || !orgSecret.vault_secret_id) {
            return null;
        }

        const vaultSecretId = orgSecret.vault_secret_id;

        // 2. Consultar directamente vault.decrypted_secrets vía Postgres Pool
        const pool = getPgPool();
        const res = await pool.query(
            'SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id = $1 LIMIT 1;',
            [vaultSecretId]
        );

        if (res.rows && res.rows.length > 0 && res.rows[0].decrypted_secret) {
            const val = res.rows[0].decrypted_secret;
            secretCache.set(cacheKey, { value: val, expiresAt: now + CACHE_TTL_MS });
            return val;
        }

        return null;
    } catch (err) {
        logger.error({ err, secretKey, organizationId }, '[SecretService] Error resolviendo secreto');
        return null;
    }
}

/**
 * Guarda o actualiza un secreto en Supabase Vault (`vault.create_secret`) y en `organization_secrets`.
 *
 * FASE B.1/B.2: escribe siempre contra la organización DUEÑA del grupo de
 * credenciales de `organizationId`, nunca contra `organizationId` en sí — así
 * `setSecret` siempre afecta el secreto real y compartido del grupo,
 * independientemente de qué organización miembro lo haya invocado. Quién
 * tiene permitido invocarlo es una decisión de la capa de ruta (B.2,
 * `routes/organization-onboarding.ts`), no de este servicio: aquí solo se
 * garantiza que el resultado es siempre coherente para todo el grupo. En
 * grupo de uno, `ownerOrganizationId === organizationId`, comportamiento
 * idéntico al de antes de que existieran los grupos.
 */
export async function setSecret(
    organizationId: string,
    secretKey: SecretKey,
    secretValue: string
): Promise<boolean> {
    const ownerOrganizationId = await resolveSecretOwnerId(organizationId);
    const pool = getPgPool();
    const vaultSecretName = `org:${ownerOrganizationId}:${secretKey}`;

    try {
        let vaultSecretId: string | null = null;

        // 1. Buscar si ya existe un secreto en Vault con ese nombre
        const existingRes = await pool.query(
            'SELECT id FROM vault.secrets WHERE name = $1 LIMIT 1;',
            [vaultSecretName]
        );

        if (existingRes.rows && existingRes.rows.length > 0) {
            vaultSecretId = existingRes.rows[0].id;
            await pool.query('SELECT vault.update_secret($1, $2);', [vaultSecretId, secretValue]);
        } else {
            // Crear nuevo secreto vía función oficial vault.create_secret
            const createRes = await pool.query(
                'SELECT vault.create_secret($1, $2, $3) AS id;',
                [secretValue, vaultSecretName, `Secreto ${secretKey} de organización ${ownerOrganizationId}`]
            );
            if (createRes.rows && createRes.rows.length > 0) {
                vaultSecretId = createRes.rows[0].id;
            }
        }

        if (!vaultSecretId) {
            logger.error({ secretKey, organizationId, ownerOrganizationId }, '[SecretService] No se pudo crear o resolver vaultSecretId');
            return false;
        }

        // 2. Guardar enlace en organization_secrets, contra la organización dueña.
        const { error: linkErr } = await supabaseAdmin
            .from('organization_secrets')
            .upsert(
                {
                    organization_id: ownerOrganizationId,
                    secret_key: secretKey,
                    vault_secret_id: vaultSecretId,
                },
                { onConflict: 'organization_id,secret_key' }
            );

        if (linkErr) {
            logger.error({ err: linkErr, secretKey, organizationId, ownerOrganizationId }, '[SecretService] Error al vincular en organization_secrets');
            return false;
        }

        clearSecretCache(ownerOrganizationId);
        return true;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, secretKey, organizationId, ownerOrganizationId, msg }, '[SecretService] Excepción guardando secreto');
        return false;
    }
}

export interface SecretStatus {
    present: boolean;
    rotatedAt: string | null;
}

/**
 * Reporta qué claves de `organization_secrets` existen para una organización
 * y cuándo rotaron, SIN tocar Vault — solo la tabla de referencias. Pensado
 * para endpoints de readiness/estado (routes/organization-onboarding.ts) que
 * no necesitan el valor del secreto, solo saber si ya fue dado de alta.
 *
 * FASE B.2: resuelve contra la organización DUEÑA del grupo, igual que
 * `getSecret`/`setSecret` — así un miembro no-owner de un grupo compartido ve
 * en solo lectura que la llave existe (y cuándo rotó), aunque él nunca la
 * haya guardado en su propia fila de `organization_secrets`. Grupo de uno:
 * mismo resultado que antes.
 *
 * Las claves ausentes en `organization_secrets` no aparecen en el objeto
 * devuelto — el llamador decide qué claves espera y las trata como
 * `present: false` si faltan.
 */
export async function listSecretStatus(organizationId: string): Promise<Record<string, SecretStatus>> {
    if (!organizationId) {
        return {};
    }

    const ownerOrganizationId = await resolveSecretOwnerId(organizationId);

    const { data, error } = await supabaseAdmin
        .from('organization_secrets')
        .select('secret_key, rotated_at')
        .eq('organization_id', ownerOrganizationId);

    if (error || !data) {
        return {};
    }

    const result: Record<string, SecretStatus> = {};
    for (const row of data) {
        result[row.secret_key] = { present: true, rotatedAt: row.rotated_at ?? null };
    }
    return result;
}

/**
 * Limpia la caché de secretos en memoria.
 */
export function clearSecretCache(organizationId?: string): void {
    if (!organizationId) {
        secretCache.clear();
        return;
    }

    for (const key of secretCache.keys()) {
        if (key.startsWith(`${organizationId}:`)) {
            secretCache.delete(key);
        }
    }
}
