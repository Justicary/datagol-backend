import pg from 'pg';
import { validateEnv } from '../../config/env.js';
import { parseDatabaseUrl } from '../../lib/database-url.js';
import { logger } from '../../lib/logger.js';

/**
 * Almacenamiento de credenciales IMAP/SMTP por buzón en Supabase Vault.
 *
 * No reutiliza `organization_secrets`/`secret-service.ts`: esa tabla tiene un
 * CHECK constraint fijo (`SECRET_KEYS`) pensado para UN secreto por tipo por
 * organización (`elevenlabs_api_key`, etc.), no para N buzones por
 * organización. En su lugar, cada fila de `email_accounts` guarda su propio
 * `vault_secret_id`, apuntando directo a Supabase Vault con el mismo
 * mecanismo interno (`vault.create_secret`/`vault.update_secret` vía
 * `pg.Pool`, porque `vault.decrypted_secrets` no está expuesto vía PostgREST).
 *
 * El valor guardado en Vault es un único JSON serializado
 * `{ imapPassword, smtpPassword }` — un secreto por cuenta, no dos.
 */

export interface EmailAccountCredentials {
    imapPassword: string;
    smtpPassword: string;
}

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

function vaultSecretName(organizationId: string, emailAccountId: string): string {
    return `org:${organizationId}:email_account:${emailAccountId}`;
}

/**
 * Crea el secreto en Vault (una cuenta nueva no tiene `vault_secret_id`
 * todavía) y devuelve su id para persistirlo en `email_accounts.vault_secret_id`.
 */
export async function storeAccountCredentials(
    organizationId: string,
    emailAccountId: string,
    credentials: EmailAccountCredentials
): Promise<string | null> {
    const pool = getPgPool();
    const name = vaultSecretName(organizationId, emailAccountId);
    const value = JSON.stringify(credentials);

    try {
        const createRes = await pool.query(
            'SELECT vault.create_secret($1, $2, $3) AS id;',
            [value, name, `Credenciales IMAP/SMTP del buzón ${emailAccountId} de organización ${organizationId}`]
        );

        if (createRes.rows && createRes.rows.length > 0 && createRes.rows[0].id) {
            return createRes.rows[0].id as string;
        }

        logger.error({ organizationId, emailAccountId }, '[EmailAccountVault] vault.create_secret no devolvió id');
        return null;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, organizationId, emailAccountId, msg }, '[EmailAccountVault] Excepción creando credenciales');
        return null;
    }
}

/**
 * Rota (sobreescribe) las credenciales de un buzón ya existente.
 */
export async function rotateAccountCredentials(
    vaultSecretId: string,
    credentials: EmailAccountCredentials
): Promise<boolean> {
    const pool = getPgPool();
    try {
        await pool.query('SELECT vault.update_secret($1, $2);', [vaultSecretId, JSON.stringify(credentials)]);
        return true;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, vaultSecretId, msg }, '[EmailAccountVault] Excepción rotando credenciales');
        return false;
    }
}

/**
 * Lee y deserializa las credenciales de un buzón desde Vault. Devuelve
 * `null` ante cualquier fallo (fila huérfana, JSON corrupto, error de
 * infraestructura) — nunca lanza, para que el llamador degrade con un
 * mensaje verbalizable en vez de un 500 mudo.
 */
export async function getAccountCredentials(vaultSecretId: string): Promise<EmailAccountCredentials | null> {
    if (!vaultSecretId) {
        return null;
    }

    try {
        const pool = getPgPool();
        const res = await pool.query(
            'SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id = $1 LIMIT 1;',
            [vaultSecretId]
        );

        if (!res.rows || res.rows.length === 0 || !res.rows[0].decrypted_secret) {
            return null;
        }

        const parsed = JSON.parse(res.rows[0].decrypted_secret) as Partial<EmailAccountCredentials>;
        if (typeof parsed.imapPassword !== 'string' || typeof parsed.smtpPassword !== 'string') {
            logger.error({ vaultSecretId }, '[EmailAccountVault] Secreto con forma inesperada (falta imapPassword/smtpPassword)');
            return null;
        }

        return { imapPassword: parsed.imapPassword, smtpPassword: parsed.smtpPassword };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, vaultSecretId, msg }, '[EmailAccountVault] Error resolviendo credenciales');
        return null;
    }
}

/**
 * Elimina el secreto de Vault al desvincular una cuenta. No lanza si ya no
 * existe (idempotente por diseño, igual que el resto de este módulo).
 */
export async function deleteAccountCredentials(vaultSecretId: string): Promise<void> {
    if (!vaultSecretId) return;
    try {
        const pool = getPgPool();
        await pool.query('DELETE FROM vault.secrets WHERE id = $1;', [vaultSecretId]);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, vaultSecretId, msg }, '[EmailAccountVault] Error eliminando credenciales');
    }
}
