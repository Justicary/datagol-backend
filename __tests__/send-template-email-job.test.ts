import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

let smtpShouldFail = false;
let lastSendMailArgs: Record<string, unknown> | null = null;

vi.mock('nodemailer', () => ({
    default: {
        createTransport: vi.fn().mockImplementation(() => ({
            sendMail: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
                lastSendMailArgs = args;
                if (smtpShouldFail) throw new Error('Simulated SMTP send failure');
                return { messageId: 'mocked-message-id@example.invalid' };
            }),
            close: vi.fn(),
        })),
    },
}));

import { supabaseAdmin } from '../src/lib/supabase.js';
import { storeAccountCredentials, deleteAccountCredentials } from '../src/services/email/email-account-vault.js';
import { sendTemplateEmailHandler } from '../src/jobs/send-template-email.js';

function fakeFastify() {
    return { log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as unknown as import('fastify').FastifyInstance;
}

function fakeJob(outboxId: string) {
    return { id: crypto.randomUUID(), data: { outboxId } } as unknown as import('pg-boss').Job<{ outboxId: string }>;
}

async function insertOutboxRow(overrides: Record<string, unknown> = {}) {
    const { data, error } = await supabaseAdmin
        .from('email_outbox')
        .insert({
            organization_id: overrides.organization_id,
            email_account_id: overrides.email_account_id,
            idempotency_key: `job-test-${crypto.randomUUID()}`,
            to_addresses: ['destino@example.invalid'],
            subject: 'Asunto de prueba',
            body_text: 'Cuerpo de prueba en texto plano.',
            body_html: '<p>Cuerpo de prueba</p>',
            status: 'draft',
            ...overrides,
        })
        .select('id')
        .single();
    if (error || !data) throw new Error(`No se pudo insertar fila de email_outbox: ${error?.message}`);
    return data.id as string;
}

describe('jobs/send-template-email.ts — sendTemplateEmailHandler', () => {
    let orgId: string;
    let emailAccountId: string;
    let vaultSecretId: string;

    beforeAll(async () => {
        const { data: org, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org Pruebas Job Send Template', email: `test-job-send-template-${crypto.randomUUID()}@example.invalid` })
            .select('id')
            .single();
        if (error || !org) throw new Error(`No se pudo crear la organización: ${error?.message}`);
        orgId = org.id as string;

        emailAccountId = crypto.randomUUID();
        const storedSecretId = await storeAccountCredentials(orgId, emailAccountId, { imapPassword: 'x', smtpPassword: 'x' });
        if (!storedSecretId) throw new Error('No se pudo guardar el secreto de prueba en Vault');
        vaultSecretId = storedSecretId;

        const { error: accountErr } = await supabaseAdmin.from('email_accounts').insert({
            id: emailAccountId,
            organization_id: orgId,
            email_address: `buzon-job-${crypto.randomUUID()}@example.invalid`,
            imap_host: 'imap.example.invalid',
            imap_port: 993,
            imap_secure: true,
            imap_username: 'usuario-imap',
            smtp_host: 'smtp.example.invalid',
            smtp_port: 465,
            smtp_secure: true,
            smtp_username: 'usuario-smtp',
            vault_secret_id: vaultSecretId,
            status: 'active',
        });
        if (accountErr) throw new Error(`No se pudo crear email_accounts: ${accountErr.message}`);
    });

    afterAll(async () => {
        await supabaseAdmin.from('email_outbox').delete().eq('organization_id', orgId);
        await deleteAccountCredentials(vaultSecretId);
        await supabaseAdmin.from('email_accounts').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
    });

    beforeEach(() => {
        smtpShouldFail = false;
        lastSendMailArgs = null;
    });

    it('contraparte de éxito: envía y transiciona la fila a sent con provider_message_id', async () => {
        const outboxId = await insertOutboxRow({ organization_id: orgId, email_account_id: emailAccountId });

        await sendTemplateEmailHandler(fakeFastify(), fakeJob(outboxId));

        const { data: row } = await supabaseAdmin
            .from('email_outbox')
            .select('status, provider_message_id, error_message, sent_at')
            .eq('id', outboxId)
            .single();
        expect(row?.status).toBe('sent');
        expect(row?.provider_message_id).toBe('mocked-message-id@example.invalid');
        expect(row?.error_message).toBeNull();
        expect(row?.sent_at).not.toBeNull();
    });

    it('fallo de SMTP: transiciona la fila a failed con error_message, sin lanzar', async () => {
        smtpShouldFail = true;
        const outboxId = await insertOutboxRow({ organization_id: orgId, email_account_id: emailAccountId });

        await expect(sendTemplateEmailHandler(fakeFastify(), fakeJob(outboxId))).resolves.not.toThrow();

        const { data: row } = await supabaseAdmin.from('email_outbox').select('status, error_message').eq('id', outboxId).single();
        expect(row?.status).toBe('failed');
        expect(row?.error_message).toContain('Simulated SMTP send failure');
    });

    it('es no-op si la fila ya no está en draft (evita reenvío ante reintento de pg-boss)', async () => {
        const outboxId = await insertOutboxRow({ organization_id: orgId, email_account_id: emailAccountId, status: 'sent' });

        await sendTemplateEmailHandler(fakeFastify(), fakeJob(outboxId));

        expect(lastSendMailArgs).toBeNull();
        const { data: row } = await supabaseAdmin.from('email_outbox').select('status').eq('id', outboxId).single();
        expect(row?.status).toBe('sent');
    });

    it('propaga adjuntos y reply_to a nodemailer', async () => {
        const attachmentContent = Buffer.from('contenido de prueba').toString('base64');
        const outboxId = await insertOutboxRow({
            organization_id: orgId,
            email_account_id: emailAccountId,
            reply_to: 'ventas@example.invalid',
            attachments: [{ filename: 'nota.txt', contentType: 'text/plain', contentBase64: attachmentContent }],
        });

        await sendTemplateEmailHandler(fakeFastify(), fakeJob(outboxId));

        expect(lastSendMailArgs?.replyTo).toBe('ventas@example.invalid');
        const attachments = lastSendMailArgs?.attachments as Array<{ filename: string; content: Buffer }>;
        expect(attachments).toHaveLength(1);
        expect(attachments[0].filename).toBe('nota.txt');
        expect(attachments[0].content.toString('utf8')).toBe('contenido de prueba');
    });
});
