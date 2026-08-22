import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

let imapShouldFail = false;
let smtpShouldFail = false;
let mockSearchUids: number[] = [];
let mockEnvelope: { subject?: string; from?: { address: string }[]; to?: { address: string }[]; date?: string } = {};
let mockSource: Buffer | false = false;

vi.mock('imapflow', () => ({
    // `new ImapFlow(...)` exige que la implementación sea invocable con
    // `new` — una arrow function no lo es (lanza "is not a constructor").
    ImapFlow: vi.fn().mockImplementation(function ImapFlowMock() {
        return {
            connect: vi.fn().mockImplementation(async () => {
                if (imapShouldFail) throw new Error('Simulated IMAP connection failure');
            }),
            logout: vi.fn().mockResolvedValue(undefined),
            getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
            search: vi.fn().mockImplementation(async () => mockSearchUids),
            fetch: vi.fn().mockImplementation((uids: number[]) => {
                const items = uids.filter((u) => mockSearchUids.includes(u)).map((uid) => ({ uid, envelope: mockEnvelope }));
                let i = 0;
                return {
                    [Symbol.asyncIterator]: () => ({
                        next: async () => (i < items.length ? { value: items[i++], done: false } : { value: undefined, done: true }),
                    }),
                };
            }),
            fetchOne: vi.fn().mockImplementation(async (uid: string) => {
                if (mockSource === false) return false;
                return { uid: Number(uid), envelope: mockEnvelope, source: mockSource };
            }),
        };
    }),
}));

vi.mock('nodemailer', () => ({
    default: {
        createTransport: vi.fn().mockImplementation(() => ({
            verify: vi.fn().mockResolvedValue(true),
            sendMail: vi.fn().mockImplementation(async () => {
                if (smtpShouldFail) throw new Error('Simulated SMTP send failure');
                return { messageId: 'mocked-message-id@example.invalid' };
            }),
            close: vi.fn(),
        })),
    },
}));

vi.mock('mailparser', () => ({
    simpleParser: vi.fn().mockImplementation(async () => ({
        text: 'Cuerpo de prueba en texto plano.',
        html: false,
        messageId: '<mock-message-id@example.invalid>',
        inReplyTo: null,
    })),
}));

import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { emailToolRoute } from '../src/routes/tools/email.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { validateAndSaveAccount } from '../src/services/email/email-account.service.js';
import { deleteAccountCredentials } from '../src/services/email/email-account-vault.js';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(emailToolRoute);
    await app.ready();
    return app;
}

describe('POST /tools/:webhookToken/email/{search,read,dispatch}', () => {
    let orgId: string;
    let accountId: string;
    const webhookToken = `email-tool-test-token-${Date.now()}`;
    const toolSecret = 'email-tool-test-secret';

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org Pruebas Tools Email',
                email: `test-tools-email-${crypto.randomUUID()}@example.invalid`,
                webhook_token: webhookToken,
                status: 'active',
                max_mailboxes: null,
            })
            .select('id')
            .single();
        if (error || !data) throw new Error(`No se pudo crear la organización: ${error?.message}`);
        orgId = data.id as string;

        const saved = await setSecret(orgId, SECRET_KEYS.TOOL_WEBHOOK_SECRET, toolSecret);
        if (!saved) throw new Error('No se pudo guardar tool_webhook_secret de prueba');
        clearSecretCache(orgId);

        const created = await validateAndSaveAccount(orgId, {
            emailAddress: `buzon-tools-${crypto.randomUUID()}@example.invalid`,
            providerLabel: 'custom',
            imapHost: 'imap.example.invalid',
            imapPort: 993,
            imapSecure: true,
            imapUsername: 'usuario-imap',
            imapPassword: 'clave-imap',
            smtpHost: 'smtp.example.invalid',
            smtpPort: 465,
            smtpSecure: true,
            smtpUsername: 'usuario-smtp',
            smtpPassword: 'clave-smtp',
        });
        if (!created.success) throw new Error(`No se pudo crear el buzón de prueba: ${created.error}`);
        accountId = created.account.id;
    });

    afterAll(async () => {
        const { data: row } = await supabaseAdmin.from('email_accounts').select('vault_secret_id').eq('id', accountId).maybeSingle();
        if (row?.vault_secret_id) await deleteAccountCredentials(row.vault_secret_id as string);
        await supabaseAdmin.from('email_outbox').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('email_accounts').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        clearSecretCache(orgId);
    });

    beforeEach(() => {
        imapShouldFail = false;
        smtpShouldFail = false;
        mockSearchUids = [];
        mockEnvelope = {};
        mockSource = false;
    });

    describe('autenticación (compartida por las tres rutas)', () => {
        it('rechaza con 401 si falta x-tool-secret', async () => {
            const app = await buildTestApp();
            const response = await app.inject({ method: 'POST', url: `/tools/${webhookToken}/email/search`, payload: {} });
            expect(response.statusCode).toBe(401);
            await app.close();
        });

        it('rechaza con 401 si x-tool-secret es incorrecto', async () => {
            const app = await buildTestApp();
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${webhookToken}/email/search`,
                headers: { 'x-tool-secret': 'secreto-incorrecto' },
                payload: {},
            });
            expect(response.statusCode).toBe(401);
            await app.close();
        });
    });

    describe('POST /email/search', () => {
        it('rechaza con 400 si "since" no es una fecha válida', async () => {
            const app = await buildTestApp();
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${webhookToken}/email/search`,
                headers: { 'x-tool-secret': toolSecret },
                payload: { since: 'no-es-una-fecha' },
            });
            expect(response.statusCode).toBe(400);
            await app.close();
        });

        it('contraparte de éxito: con filtros válidos devuelve found:true y los mensajes encontrados', async () => {
            mockSearchUids = [101];
            mockEnvelope = { subject: 'Asunto de prueba', from: [{ address: 'remitente@example.invalid' }], date: '2026-01-10T10:00:00Z' };

            const app = await buildTestApp();
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${webhookToken}/email/search`,
                headers: { 'x-tool-secret': toolSecret },
                payload: { subject: 'prueba' },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.found).toBe(true);
            expect(body.messages).toHaveLength(1);
            expect(body.messages[0].uid).toBe(101);
            expect(body.messages[0].subject).toBe('Asunto de prueba');
            await app.close();
        });

        it('degrada con 200 y mensaje verbalizable si la conexión IMAP falla', async () => {
            imapShouldFail = true;
            const app = await buildTestApp();
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${webhookToken}/email/search`,
                headers: { 'x-tool-secret': toolSecret },
                payload: {},
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.found).toBe(false);
            expect(body.message).toContain('No puedo consultar el correo');
            await app.close();
        });

        it('degrada con 200 y mensaje verbalizable si la organización no tiene ningún buzón activo', async () => {
            await supabaseAdmin.from('email_accounts').update({ status: 'disabled' }).eq('id', accountId);
            try {
                const app = await buildTestApp();
                const response = await app.inject({
                    method: 'POST',
                    url: `/tools/${webhookToken}/email/search`,
                    headers: { 'x-tool-secret': toolSecret },
                    payload: {},
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.found).toBe(false);
                expect(body.message).toContain('No tengo un buzón de correo configurado');
                await app.close();
            } finally {
                await supabaseAdmin.from('email_accounts').update({ status: 'active' }).eq('id', accountId);
            }
        });
    });

    describe('POST /email/read', () => {
        it('rechaza con 400 si "uid" no es un entero positivo', async () => {
            const app = await buildTestApp();
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${webhookToken}/email/read`,
                headers: { 'x-tool-secret': toolSecret },
                payload: { uid: 'no-es-un-numero-valido-como-uid-????' },
            });
            expect([400]).toContain(response.statusCode);
            await app.close();
        });

        it('contraparte de éxito: con un uid existente devuelve found:true y el cuerpo limpio del correo', async () => {
            mockSource = Buffer.from('Contenido crudo simulado del mensaje.');
            mockEnvelope = { subject: 'Correo de prueba', from: [{ address: 'remitente@example.invalid' }], to: [{ address: 'destino@example.invalid' }] };

            const app = await buildTestApp();
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${webhookToken}/email/read`,
                headers: { 'x-tool-secret': toolSecret },
                payload: { uid: 202 },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.found).toBe(true);
            expect(body.email.bodyText).toBe('Cuerpo de prueba en texto plano.');
            await app.close();
        });

        it('devuelve found:false si el mensaje no existe', async () => {
            mockSource = false;
            const app = await buildTestApp();
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${webhookToken}/email/read`,
                headers: { 'x-tool-secret': toolSecret },
                payload: { uid: 999 },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().found).toBe(false);
            await app.close();
        });
    });

    describe('POST /email/dispatch', () => {
        it('rechaza con 400 si falta "idempotencyKey"', async () => {
            const app = await buildTestApp();
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${webhookToken}/email/dispatch`,
                headers: { 'x-tool-secret': toolSecret },
                payload: { toAddresses: ['destino@example.invalid'], subject: 'Hola', bodyText: 'Cuerpo' },
            });
            expect(response.statusCode).toBe(400);
            await app.close();
        });

        it('contraparte de éxito: guarda un borrador (is_draft) sin invocar SMTP', async () => {
            const app = await buildTestApp();
            const idempotencyKey = `draft-${crypto.randomUUID()}`;
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${webhookToken}/email/dispatch`,
                headers: { 'x-tool-secret': toolSecret },
                payload: {
                    idempotencyKey,
                    toAddresses: ['destino@example.invalid'],
                    subject: 'Borrador de prueba',
                    bodyText: 'Cuerpo del borrador',
                    isDraft: true,
                },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.dispatched).toBe(true);
            expect(body.status).toBe('draft');

            const { data: row } = await supabaseAdmin.from('email_outbox').select('status').eq('organization_id', orgId).eq('idempotency_key', idempotencyKey).single();
            expect(row?.status).toBe('draft');
            await app.close();
        });

        it('envía un correo real (mockeado) cuando is_draft es falso y registra provider_message_id', async () => {
            const app = await buildTestApp();
            const idempotencyKey = `send-${crypto.randomUUID()}`;
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${webhookToken}/email/dispatch`,
                headers: { 'x-tool-secret': toolSecret },
                payload: {
                    idempotencyKey,
                    toAddresses: ['destino@example.invalid'],
                    subject: 'Envío real',
                    bodyText: 'Cuerpo del envío',
                    isDraft: false,
                },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.dispatched).toBe(true);
            expect(body.status).toBe('sent');

            const { data: row } = await supabaseAdmin.from('email_outbox').select('status, provider_message_id').eq('organization_id', orgId).eq('idempotency_key', idempotencyKey).single();
            expect(row?.status).toBe('sent');
            expect(row?.provider_message_id).toBe('mocked-message-id@example.invalid');
            await app.close();
        });

        it('idempotencia: el mismo idempotencyKey enviado dos veces produce exactamente un envío', async () => {
            const app = await buildTestApp();
            const idempotencyKey = `idempotent-${crypto.randomUUID()}`;
            const payload = {
                idempotencyKey,
                toAddresses: ['destino@example.invalid'],
                subject: 'Idempotencia',
                bodyText: 'Cuerpo',
                isDraft: false,
            };

            const first = await app.inject({ method: 'POST', url: `/tools/${webhookToken}/email/dispatch`, headers: { 'x-tool-secret': toolSecret }, payload });
            const second = await app.inject({ method: 'POST', url: `/tools/${webhookToken}/email/dispatch`, headers: { 'x-tool-secret': toolSecret }, payload });

            expect(first.statusCode).toBe(200);
            expect(second.statusCode).toBe(200);
            expect(first.json().dispatched).toBe(true);
            expect(second.json().dispatched).toBe(true);

            const { data: rows } = await supabaseAdmin.from('email_outbox').select('id').eq('organization_id', orgId).eq('idempotency_key', idempotencyKey);
            expect(rows?.length).toBe(1);
            await app.close();
        });

        it('degrada con 200 si el envío SMTP falla', async () => {
            smtpShouldFail = true;
            const app = await buildTestApp();
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${webhookToken}/email/dispatch`,
                headers: { 'x-tool-secret': toolSecret },
                payload: {
                    idempotencyKey: `fail-${crypto.randomUUID()}`,
                    toAddresses: ['destino@example.invalid'],
                    subject: 'Fallo simulado',
                    bodyText: 'Cuerpo',
                    isDraft: false,
                },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().dispatched).toBe(false);
            await app.close();
        });
    });
});
