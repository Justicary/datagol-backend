import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { supabaseAdmin } from '../lib/supabase.js';
import { getAccountCredentials } from '../services/email/email-account-vault.js';
import { sendEmail, SmtpConnectionError, type SendEmailAttachment } from '../services/email/smtp-client.js';

export const SEND_TEMPLATE_EMAIL_QUEUE = 'send-template-email';

export interface SendTemplateEmailJobData {
    outboxId: string;
}

interface OutboxRow {
    id: string;
    organization_id: string;
    email_account_id: string;
    status: string;
    to_addresses: string[];
    subject: string;
    body_text: string;
    body_html: string | null;
    reply_to: string | null;
    attachments: Array<{ filename: string; contentType: string; contentBase64: string }> | null;
}

interface AccountRow {
    email_address: string;
    smtp_host: string;
    smtp_port: number;
    smtp_secure: boolean;
    smtp_username: string;
    vault_secret_id: string;
    status: string;
}

async function markOutcome(outboxId: string, outcome: { status: 'sent' | 'failed'; providerMessageId?: string | null; errorMessage?: string | null }) {
    await supabaseAdmin
        .from('email_outbox')
        .update({
            status: outcome.status,
            provider_message_id: outcome.providerMessageId ?? null,
            error_message: outcome.errorMessage ?? null,
            sent_at: outcome.status === 'sent' ? new Date().toISOString() : null,
        })
        .eq('id', outboxId);
}

/**
 * Worker asíncrono del envío por lote de `send-template-email`
 * (docs/tasks/send-template-email-backend.md). `job.data` solo trae
 * `outboxId` — todo lo demás (destinatario, HTML, adjuntos) se relee de la
 * fila, mismo criterio que `send-thank-you.ts`. Idempotente ante reintento
 * de pg-boss: si la fila ya no está en `draft` (un intento anterior de este
 * mismo job ya la resolvió), no hace nada.
 */
export async function sendTemplateEmailHandler(fastify: FastifyInstance, job: Job<SendTemplateEmailJobData>): Promise<void> {
    const { outboxId } = job.data;
    if (!outboxId) {
        throw new Error('sendTemplateEmailHandler invocado sin outboxId');
    }

    const { data: outboxRow, error: outboxErr } = await supabaseAdmin
        .from('email_outbox')
        .select('id, organization_id, email_account_id, status, to_addresses, subject, body_text, body_html, reply_to, attachments')
        .eq('id', outboxId)
        .maybeSingle();

    if (outboxErr || !outboxRow) {
        fastify.log.error({ outboxId, err: outboxErr }, '[SendTemplateEmailJob] Fila de email_outbox no encontrada');
        return;
    }

    const row = outboxRow as OutboxRow;
    if (row.status !== 'draft') {
        // Ya procesada (envío exitoso, fallido, o un reintento anterior de
        // este mismo job) — no hay nada que reenviar.
        return;
    }

    const { data: accountRow, error: accountErr } = await supabaseAdmin
        .from('email_accounts')
        .select('email_address, smtp_host, smtp_port, smtp_secure, smtp_username, vault_secret_id, status')
        .eq('id', row.email_account_id)
        .maybeSingle();

    if (accountErr || !accountRow) {
        await markOutcome(outboxId, { status: 'failed', errorMessage: 'El buzón emisor ya no existe.' });
        return;
    }

    const account = accountRow as AccountRow;
    if (account.status !== 'active') {
        await markOutcome(outboxId, { status: 'failed', errorMessage: 'El buzón emisor ya no está activo.' });
        return;
    }

    const credentials = await getAccountCredentials(account.vault_secret_id);
    if (!credentials) {
        await markOutcome(outboxId, { status: 'failed', errorMessage: 'No se pudieron recuperar las credenciales del buzón.' });
        return;
    }

    const attachments: SendEmailAttachment[] = (row.attachments ?? []).map((att) => ({
        filename: att.filename,
        content: Buffer.from(att.contentBase64, 'base64'),
        contentType: att.contentType,
    }));

    try {
        const result = await sendEmail(
            {
                host: account.smtp_host,
                port: account.smtp_port,
                secure: account.smtp_secure,
                user: account.smtp_username,
                pass: credentials.smtpPassword,
            },
            {
                fromAddress: account.email_address,
                to: row.to_addresses,
                replyTo: row.reply_to ?? undefined,
                subject: row.subject,
                text: row.body_text,
                html: row.body_html ?? undefined,
                attachments: attachments.length > 0 ? attachments : undefined,
            }
        );

        await markOutcome(outboxId, { status: 'sent', providerMessageId: result.providerMessageId });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const isConnectionError = err instanceof SmtpConnectionError;
        fastify.log.warn(
            { outboxId, organizationId: row.organization_id, err, msg, isConnectionError },
            '[SendTemplateEmailJob] Fallo de envío SMTP'
        );
        await markOutcome(outboxId, { status: 'failed', errorMessage: msg });
    }
}

export async function registerSendTemplateEmailWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(SEND_TEMPLATE_EMAIL_QUEUE, {
        retryLimit: 3,
        retryBackoff: true,
    });

    await fastify.pgBoss.work<SendTemplateEmailJobData>(SEND_TEMPLATE_EMAIL_QUEUE, async ([job]) => {
        await sendTemplateEmailHandler(fastify, job);
    });
}
