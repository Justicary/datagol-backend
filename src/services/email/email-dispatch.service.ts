import { supabaseAdmin } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';
import { getAccountCredentials } from './email-account-vault.js';
import { sendEmail } from './smtp-client.js';

/**
 * Orquesta el envío (o guardado de borrador) de correo saliente, con
 * idempotencia obligatoria (AGENTS.md §4): un mismo `idempotencyKey`
 * reintentado por el LLM/webhook nunca produce un segundo envío.
 */

export interface DispatchEmailPayload {
    idempotencyKey: string;
    toAddresses: string[];
    ccAddresses?: string[];
    subject: string;
    bodyText: string;
    bodyHtml?: string | null;
    contactId?: string | null;
    isDraft: boolean;
}

export type DispatchOutcomeStatus = 'draft' | 'sent';

export type DispatchEmailResult =
    | { success: true; outboxId: string; status: DispatchOutcomeStatus; message: string }
    | { success: false; error: string; statusCode: 400 | 404 };

interface EmailAccountForDispatch {
    id: string;
    email_address: string;
    smtp_host: string;
    smtp_port: number;
    smtp_secure: boolean;
    smtp_username: string;
    vault_secret_id: string;
    status: string;
}

export async function dispatchOrSaveDraft(
    organizationId: string,
    emailAccountId: string,
    payload: DispatchEmailPayload
): Promise<DispatchEmailResult> {
    const existingResult = await findExistingByIdempotencyKey(organizationId, payload.idempotencyKey);
    if (existingResult) {
        return existingResult;
    }

    const { data: account, error: accountErr } = await supabaseAdmin
        .from('email_accounts')
        .select('id, email_address, smtp_host, smtp_port, smtp_secure, smtp_username, vault_secret_id, status')
        .eq('id', emailAccountId)
        .eq('organization_id', organizationId)
        .maybeSingle();

    if (accountErr || !account) {
        return { success: false, error: 'El buzón indicado no existe o no pertenece a esta organización.', statusCode: 404 };
    }
    const typedAccount = account as EmailAccountForDispatch;

    if (payload.isDraft) {
        return insertOutboxRow(organizationId, emailAccountId, payload, {
            status: 'draft',
            providerMessageId: null,
            sentAt: null,
        });
    }

    if (typedAccount.status !== 'active') {
        return { success: false, error: 'Este buzón no está activo; no se puede enviar el correo.', statusCode: 400 };
    }

    const credentials = await getAccountCredentials(typedAccount.vault_secret_id);
    if (!credentials) {
        return {
            success: false,
            error: 'No se pudieron recuperar las credenciales del buzón. Verifica la configuración del buzón.',
            statusCode: 400,
        };
    }

    let providerMessageId: string | null = null;
    let sendError: string | null = null;
    try {
        const result = await sendEmail(
            {
                host: typedAccount.smtp_host,
                port: typedAccount.smtp_port,
                secure: typedAccount.smtp_secure,
                user: typedAccount.smtp_username,
                pass: credentials.smtpPassword,
            },
            {
                fromAddress: typedAccount.email_address,
                to: payload.toAddresses,
                cc: payload.ccAddresses,
                subject: payload.subject,
                text: payload.bodyText,
                html: payload.bodyHtml ?? undefined,
            }
        );
        providerMessageId = result.providerMessageId;
    } catch (err) {
        sendError = err instanceof Error ? err.message : String(err);
    }

    if (sendError) {
        // El intento de envío falló. Se registra para trazabilidad (bitácora
        // append-only), pero el desenlace que ve el llamador siempre es el
        // fallo de envío real — nunca depende de si esta escritura tuvo éxito.
        await recordFailedAttempt(organizationId, emailAccountId, payload, sendError);
        return { success: false, error: `No se pudo enviar el correo: ${sendError}`, statusCode: 400 };
    }

    const insertResult = await insertOutboxRow(organizationId, emailAccountId, payload, {
        status: 'sent',
        providerMessageId,
        sentAt: new Date().toISOString(),
    });

    if (!insertResult.success) {
        // El correo SÍ se envió, pero la bitácora no se pudo escribir — se
        // informa el desenlace real del envío en vez de perderlo
        // silenciosamente detrás de un error de inserción.
        logger.error(
            { organizationId, emailAccountId, error: insertResult.error },
            '[EmailDispatchService] Correo enviado pero no se pudo registrar en email_outbox'
        );
        return { success: true, outboxId: '', status: 'sent', message: 'Correo enviado, pero no se pudo registrar la bitácora.' };
    }

    return insertResult;
}

async function findExistingByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string
): Promise<DispatchEmailResult | null> {
    const { data: existing } = await supabaseAdmin
        .from('email_outbox')
        .select('id, status, error_message')
        .eq('organization_id', organizationId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();

    if (!existing) {
        return null;
    }

    // Un intento anterior con esta misma clave falló de verdad — nada se
    // envió. Reportarlo como `success: true` (como si fuera un borrador o un
    // envío ya resuelto) le mentiría al llamador. Se repite el mismo fallo
    // en vez de reintentar el envío en silencio, para que el desenlace de un
    // idempotencyKey dado sea siempre el mismo.
    if (existing.status === 'failed') {
        return {
            success: false,
            error: existing.error_message
                ? `No se pudo enviar el correo: ${existing.error_message}`
                : 'Este correo no se pudo enviar en un intento anterior.',
            statusCode: 400,
        };
    }

    const status = existing.status as DispatchOutcomeStatus;
    return {
        success: true,
        outboxId: existing.id,
        status,
        message: status === 'sent' ? 'Este correo ya había sido enviado.' : 'Este borrador ya había sido guardado.',
    };
}

/**
 * Registro append-only de un intento de envío fallido (bitácora, AGENTS.md
 * §6). No devuelve nada porque el desenlace que ve el llamador de
 * `dispatchOrSaveDraft` es siempre el `sendError` real, nunca el resultado
 * de esta escritura — a diferencia de `insertOutboxRow`, cuyo valor de
 * retorno sí es la respuesta que recibe el cliente en los casos 'draft'/'sent'.
 * Un 23505 aquí significa que otro reintento concurrente ya registró este
 * mismo intento fallido — no es un error, no se loguea.
 */
async function recordFailedAttempt(
    organizationId: string,
    emailAccountId: string,
    payload: DispatchEmailPayload,
    errorMessage: string
): Promise<void> {
    const { error: insertErr } = await supabaseAdmin.from('email_outbox').insert({
        organization_id: organizationId,
        email_account_id: emailAccountId,
        idempotency_key: payload.idempotencyKey,
        to_addresses: payload.toAddresses,
        cc_addresses: payload.ccAddresses ?? null,
        subject: payload.subject,
        body_text: payload.bodyText,
        body_html: payload.bodyHtml ?? null,
        contact_id: payload.contactId ?? null,
        status: 'failed',
        provider_message_id: null,
        error_message: errorMessage,
        sent_at: null,
    });

    if (insertErr && insertErr.code !== '23505') {
        logger.error(
            { organizationId, emailAccountId, error: insertErr.message },
            '[EmailDispatchService] No se pudo registrar el intento de envío fallido'
        );
    }
}

async function insertOutboxRow(
    organizationId: string,
    emailAccountId: string,
    payload: DispatchEmailPayload,
    outcome: { status: 'draft' | 'sent'; providerMessageId: string | null; sentAt: string | null }
): Promise<DispatchEmailResult> {
    const { data: row, error: insertErr } = await supabaseAdmin
        .from('email_outbox')
        .insert({
            organization_id: organizationId,
            email_account_id: emailAccountId,
            idempotency_key: payload.idempotencyKey,
            to_addresses: payload.toAddresses,
            cc_addresses: payload.ccAddresses ?? null,
            subject: payload.subject,
            body_text: payload.bodyText,
            body_html: payload.bodyHtml ?? null,
            contact_id: payload.contactId ?? null,
            status: outcome.status,
            provider_message_id: outcome.providerMessageId,
            error_message: null,
            sent_at: outcome.sentAt,
        })
        .select('id')
        .single();

    if (insertErr || !row) {
        if (insertErr?.code === '23505') {
            // Carrera: otro reintento con el mismo idempotencyKey ganó primero.
            const raceWinner = await findExistingByIdempotencyKey(organizationId, payload.idempotencyKey);
            if (raceWinner) return raceWinner;
        }
        return { success: false, error: insertErr?.message ?? 'error desconocido', statusCode: 400 };
    }

    return {
        success: true,
        outboxId: row.id,
        status: outcome.status,
        message: outcome.status === 'draft' ? 'Borrador guardado.' : 'Correo enviado con éxito.',
    };
}
