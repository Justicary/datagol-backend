import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';
import { verifyImapConnection } from './imap-client.js';
import { verifySmtpConnection } from './smtp-client.js';
import { storeAccountCredentials, deleteAccountCredentials } from './email-account-vault.js';

/**
 * Alta, listado y baja de buzones IMAP/SMTP por organización
 * (docs/tasks/native-mail-integration.md §2). Las credenciales nunca se
 * persisten en esta tabla ni en `organization_secrets` — ver
 * `email-account-vault.ts` para el porqué.
 */

export interface EmailAccountConfig {
    emailAddress: string;
    providerLabel?: string | null;
    imapHost: string;
    imapPort: number;
    imapSecure: boolean;
    imapUsername: string;
    imapPassword: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUsername: string;
    smtpPassword: string;
}

export type EmailAccountStatus = 'active' | 'error' | 'disabled';

export interface EmailAccountSummary {
    id: string;
    emailAddress: string;
    providerLabel: string | null;
    imapHost: string;
    smtpHost: string;
    status: EmailAccountStatus;
    lastValidatedAt: string | null;
    lastError: string | null;
    createdAt: string;
}

interface EmailAccountRow {
    id: string;
    email_address: string;
    provider_label: string | null;
    imap_host: string;
    smtp_host: string;
    status: EmailAccountStatus;
    last_validated_at: string | null;
    last_error: string | null;
    created_at: string;
}

const ACCOUNT_SELECT_COLUMNS =
    'id, email_address, provider_label, imap_host, smtp_host, status, last_validated_at, last_error, created_at';

export type ValidateAndSaveAccountResult =
    | { success: true; account: EmailAccountSummary }
    | { success: false; error: string; statusCode: 400 | 403 };

export async function validateAndSaveAccount(
    organizationId: string,
    payload: EmailAccountConfig
): Promise<ValidateAndSaveAccountResult> {
    const { data: org, error: orgErr } = await supabaseAdmin
        .from('organizations')
        .select('max_mailboxes')
        .eq('id', organizationId)
        .maybeSingle();

    if (orgErr || !org) {
        return { success: false, error: 'La organización no existe.', statusCode: 400 };
    }

    const maxMailboxes = org.max_mailboxes as number | null;
    if (maxMailboxes !== null) {
        const { count, error: countErr } = await supabaseAdmin
            .from('email_accounts')
            .select('id', { count: 'exact', head: true })
            .eq('organization_id', organizationId);

        if (countErr) {
            return { success: false, error: `No se pudo verificar el cupo de buzones: ${countErr.message}`, statusCode: 400 };
        }

        if ((count ?? 0) >= maxMailboxes) {
            return {
                success: false,
                error: `Esta organización ya alcanzó el límite de ${maxMailboxes} buzón(es) vinculado(s) para su plan. Actualiza el plan o desvincula un buzón existente antes de agregar otro.`,
                statusCode: 403,
            };
        }
    }

    const { data: existing } = await supabaseAdmin
        .from('email_accounts')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('email_address', payload.emailAddress)
        .maybeSingle();

    if (existing) {
        return {
            success: false,
            error: `Ya existe un buzón vinculado con la dirección ${payload.emailAddress} en esta organización.`,
            statusCode: 400,
        };
    }

    try {
        await verifyImapConnection({
            host: payload.imapHost,
            port: payload.imapPort,
            secure: payload.imapSecure,
            user: payload.imapUsername,
            pass: payload.imapPassword,
        });
    } catch (err) {
        return { success: false, error: describeConnectionError('IMAP', err), statusCode: 400 };
    }

    try {
        await verifySmtpConnection({
            host: payload.smtpHost,
            port: payload.smtpPort,
            secure: payload.smtpSecure,
            user: payload.smtpUsername,
            pass: payload.smtpPassword,
        });
    } catch (err) {
        return { success: false, error: describeConnectionError('SMTP', err), statusCode: 400 };
    }

    // El id se genera en código (no se deja el DEFAULT gen_random_uuid() de
    // la tabla) porque el nombre del secreto en Vault necesita el id de la
    // cuenta ANTES de que la fila exista — no hay forma de resolver esto en
    // dos pasos sin dejar una ventana donde vault_secret_id sea NULL
    // (columna NOT NULL a propósito, para que no exista un email_accounts
    // sin credenciales asociadas).
    const emailAccountId = crypto.randomUUID();
    const vaultSecretId = await storeAccountCredentials(organizationId, emailAccountId, {
        imapPassword: payload.imapPassword,
        smtpPassword: payload.smtpPassword,
    });

    if (!vaultSecretId) {
        return {
            success: false,
            error: 'No se pudieron guardar las credenciales de forma segura. Intenta de nuevo.',
            statusCode: 400,
        };
    }

    const { data: inserted, error: insertErr } = await supabaseAdmin
        .from('email_accounts')
        .insert({
            id: emailAccountId,
            organization_id: organizationId,
            email_address: payload.emailAddress,
            provider_label: payload.providerLabel ?? null,
            imap_host: payload.imapHost,
            imap_port: payload.imapPort,
            imap_secure: payload.imapSecure,
            imap_username: payload.imapUsername,
            smtp_host: payload.smtpHost,
            smtp_port: payload.smtpPort,
            smtp_secure: payload.smtpSecure,
            smtp_username: payload.smtpUsername,
            vault_secret_id: vaultSecretId,
            status: 'active',
            last_validated_at: new Date().toISOString(),
        })
        .select(ACCOUNT_SELECT_COLUMNS)
        .single();

    if (insertErr || !inserted) {
        // El secreto ya se creó en Vault; si la fila no se pudo insertar
        // (carrera con el mismo email_address, u otro error) no debe quedar
        // huérfano.
        await deleteAccountCredentials(vaultSecretId);
        if (insertErr?.code === '23505') {
            return {
                success: false,
                error: `Ya existe un buzón vinculado con la dirección ${payload.emailAddress} en esta organización.`,
                statusCode: 400,
            };
        }
        return { success: false, error: `No se pudo guardar el buzón: ${insertErr?.message ?? 'error desconocido'}`, statusCode: 400 };
    }

    return { success: true, account: mapRow(inserted as EmailAccountRow) };
}

export async function listAccounts(
    organizationId: string
): Promise<{ accounts: EmailAccountSummary[]; maxMailboxes: number | null }> {
    const { data: org } = await supabaseAdmin
        .from('organizations')
        .select('max_mailboxes')
        .eq('id', organizationId)
        .maybeSingle();

    const { data, error } = await supabaseAdmin
        .from('email_accounts')
        .select(ACCOUNT_SELECT_COLUMNS)
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: true });

    if (error) {
        throw new Error(`Error listando buzones: ${error.message}`);
    }

    return {
        accounts: ((data as EmailAccountRow[] | null) ?? []).map(mapRow),
        maxMailboxes: (org?.max_mailboxes as number | null) ?? null,
    };
}

export async function deleteAccount(
    organizationId: string,
    accountId: string
): Promise<{ success: boolean; error?: string }> {
    // El filtro `.eq('organization_id', organizationId)` en el SELECT (no
    // solo en el DELETE) es lo que impide que una organización desvincule
    // (o siquiera detecte la existencia de) el buzón de otra.
    const { data: account, error: fetchErr } = await supabaseAdmin
        .from('email_accounts')
        .select('id, vault_secret_id')
        .eq('id', accountId)
        .eq('organization_id', organizationId)
        .maybeSingle();

    if (fetchErr || !account) {
        return { success: false, error: 'El buzón no existe o no pertenece a esta organización.' };
    }

    const { error: deleteErr } = await supabaseAdmin
        .from('email_accounts')
        .delete()
        .eq('id', accountId)
        .eq('organization_id', organizationId);

    if (deleteErr) {
        return { success: false, error: `No se pudo desvincular el buzón: ${deleteErr.message}` };
    }

    await deleteAccountCredentials(account.vault_secret_id as string);
    return { success: true };
}

// Mensajes compartidos por los dos consumidores de getActiveEmailAccount
// (routes/tools/email.ts y la intención resumen-correos-recibidos de
// reportes en lenguaje natural) — texto verbalizable/mostrable tal cual.
export const NO_ACTIVE_MAILBOX_MESSAGE = 'No tengo un buzón de correo configurado en este momento.';
export const AMBIGUOUS_MAILBOX_MESSAGE = 'Esta organización tiene más de un buzón configurado; necesito que me indiques cuál usar.';

export interface EmailAccountImapConfig {
    id: string;
    imap_host: string;
    imap_port: number;
    imap_secure: boolean;
    imap_username: string;
    vault_secret_id: string;
    status: string;
}

export type GetActiveEmailAccountResult =
    | { ok: true; account: EmailAccountImapConfig }
    | { ok: false; message: string };

const IMAP_ACCOUNT_SELECT_COLUMNS = 'id, imap_host, imap_port, imap_secure, imap_username, vault_secret_id, status';

/**
 * Resuelve qué buzón IMAP usar para una organización. Extraído de
 * `routes/tools/email.ts` (antes `resolveEmailAccount`, sin exportar) para
 * que la intención `resumen-correos-recibidos` de reportes en lenguaje
 * natural (docs/tasks/reportes-nl-correos-backend.md) tenga la misma
 * fuente de verdad — sin `emailAccountId` explícito, resuelve el único
 * buzón **activo** de la organización; con 0 o más de 1, degrada con un
 * mensaje en vez de adivinar cuál usar.
 */
export async function getActiveEmailAccount(
    fastify: FastifyInstance,
    organizationId: string,
    emailAccountId?: string
): Promise<GetActiveEmailAccountResult> {
    if (emailAccountId) {
        const { data, error } = await fastify.supabaseAdmin
            .from('email_accounts')
            .select(IMAP_ACCOUNT_SELECT_COLUMNS)
            .eq('id', emailAccountId)
            .eq('organization_id', organizationId)
            .maybeSingle();

        if (error || !data) {
            return { ok: false, message: 'No encontré ese buzón para esta organización.' };
        }
        return { ok: true, account: data as EmailAccountImapConfig };
    }

    const { data, error } = await fastify.supabaseAdmin
        .from('email_accounts')
        .select(IMAP_ACCOUNT_SELECT_COLUMNS)
        .eq('organization_id', organizationId)
        .eq('status', 'active')
        .order('created_at', { ascending: true });

    if (error || !data || data.length === 0) {
        return { ok: false, message: NO_ACTIVE_MAILBOX_MESSAGE };
    }
    if (data.length > 1) {
        return { ok: false, message: AMBIGUOUS_MAILBOX_MESSAGE };
    }
    return { ok: true, account: data[0] as EmailAccountImapConfig };
}

function mapRow(row: EmailAccountRow): EmailAccountSummary {
    return {
        id: row.id,
        emailAddress: row.email_address,
        providerLabel: row.provider_label,
        imapHost: row.imap_host,
        smtpHost: row.smtp_host,
        status: row.status,
        lastValidatedAt: row.last_validated_at,
        lastError: row.last_error,
        createdAt: row.created_at,
    };
}

function describeConnectionError(protocol: 'IMAP' | 'SMTP', err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, protocol }, '[EmailAccountService] Fallo de validación de conexión');
    return `No se pudo validar la conexión ${protocol} con los datos proporcionados: ${msg}`;
}
