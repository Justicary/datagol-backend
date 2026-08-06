import pg from 'pg';
import { supabaseAdmin } from '../lib/supabase.js';
import { validateEnv } from '../config/env.js';
import { parseDatabaseUrl } from '../lib/database-url.js';
import { logger } from '../lib/logger.js';
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
 * Resuelve un secreto desde `organization_secrets` -> Supabase Vault (`vault.decrypted_secrets`).
 */
export async function getSecret(
    organizationId: string,
    secretKey: SecretKey
): Promise<string | null> {
    if (!organizationId || !secretKey) {
        return null;
    }

    const cacheKey = getCacheKey(organizationId, secretKey);
    const now = Date.now();
    const cached = secretCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
        return cached.value;
    }

    try {
        // 1. Obtener la referencia en organization_secrets
        const { data: orgSecret, error: orgSecErr } = await supabaseAdmin
            .from('organization_secrets')
            .select('vault_secret_id')
            .eq('organization_id', organizationId)
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
 */
export async function setSecret(
    organizationId: string,
    secretKey: SecretKey,
    secretValue: string
): Promise<boolean> {
    const pool = getPgPool();
    const vaultSecretName = `org:${organizationId}:${secretKey}`;

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
                [secretValue, vaultSecretName, `Secreto ${secretKey} de organización ${organizationId}`]
            );
            if (createRes.rows && createRes.rows.length > 0) {
                vaultSecretId = createRes.rows[0].id;
            }
        }

        if (!vaultSecretId) {
            logger.error({ secretKey, organizationId }, '[SecretService] No se pudo crear o resolver vaultSecretId');
            return false;
        }

        // 2. Guardar enlace en organization_secrets
        const { error: linkErr } = await supabaseAdmin
            .from('organization_secrets')
            .upsert(
                {
                    organization_id: organizationId,
                    secret_key: secretKey,
                    vault_secret_id: vaultSecretId,
                },
                { onConflict: 'organization_id,secret_key' }
            );

        if (linkErr) {
            logger.error({ err: linkErr, secretKey, organizationId }, '[SecretService] Error al vincular en organization_secrets');
            return false;
        }

        clearSecretCache(organizationId);
        return true;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, secretKey, organizationId, msg }, '[SecretService] Excepción guardando secreto');
        return false;
    }
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
