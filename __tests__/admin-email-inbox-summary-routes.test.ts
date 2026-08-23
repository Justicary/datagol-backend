import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

let imapShouldFail = false;
let mockStatus: { messages: number; unseen: number } = { messages: 0, unseen: 0 };
let mockSearchUids: number[] = [];
let mockEnvelope: { subject?: string; from?: { address: string; name?: string }[]; date?: string } = {};
let connectCallCount = 0;

vi.mock('imapflow', () => ({
    // `new ImapFlow(...)` exige que la implementación sea invocable con
    // `new` — una arrow function no lo es (lanza "is not a constructor").
    ImapFlow: vi.fn().mockImplementation(function ImapFlowMock() {
        return {
            connect: vi.fn().mockImplementation(async () => {
                connectCallCount += 1;
                if (imapShouldFail) throw new Error('Simulated IMAP connection failure');
            }),
            logout: vi.fn().mockResolvedValue(undefined),
            status: vi.fn().mockImplementation(async () => mockStatus),
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
        };
    }),
}));

vi.mock('nodemailer', () => ({
    default: {
        createTransport: vi.fn().mockImplementation(() => ({
            verify: vi.fn().mockResolvedValue(true),
            close: vi.fn(),
        })),
    },
}));

import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import adminEmailAccountsRoutes from '../src/routes/admin/email-accounts.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateAndSaveAccount } from '../src/services/email/email-account.service.js';
import { deleteAccountCredentials } from '../src/services/email/email-account-vault.js';
import { clearInboxSummaryCache } from '../src/services/email/email-summary.service.js';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(adminEmailAccountsRoutes);
    await app.ready();
    return app;
}

async function createOrg(name: string) {
    const { data, error } = await supabaseAdmin
        .from('organizations')
        .insert({ name, email: `test-inbox-summary-${crypto.randomUUID()}@example.invalid`, max_mailboxes: null })
        .select('id')
        .single();
    if (error || !data) throw new Error(`No se pudo crear la organización: ${error?.message}`);
    return data.id as string;
}

async function insertOutboxRow(
    organizationId: string,
    emailAccountId: string,
    status: 'draft' | 'sent' | 'failed',
    overrides: Record<string, unknown> = {}
) {
    const { error } = await supabaseAdmin.from('email_outbox').insert({
        organization_id: organizationId,
        email_account_id: emailAccountId,
        idempotency_key: `inbox-summary-test-${crypto.randomUUID()}`,
        to_addresses: ['destino@example.invalid'],
        subject: 'Correo de prueba',
        body_text: 'Cuerpo de prueba para el resumen de bandeja.',
        status,
        sent_at: status === 'sent' ? new Date().toISOString() : null,
        ...overrides,
    });
    if (error) throw new Error(`No se pudo insertar fila de email_outbox: ${error.message}`);
}

describe('GET /api/admin/email-accounts/organization/:orgId/inbox-summary', () => {
    let orgId: string;
    let accountId: string;
    let orgEmptyId: string;
    let orgBrokenId: string;
    let brokenAccountId: string;
    const cleanupOrgIds: string[] = [];

    beforeAll(async () => {
        orgId = await createOrg('Org Pruebas Inbox Summary');
        cleanupOrgIds.push(orgId);

        const created = await validateAndSaveAccount(orgId, {
            emailAddress: `buzon-inbox-summary-${crypto.randomUUID()}@example.invalid`,
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

        orgEmptyId = await createOrg('Org Pruebas Inbox Summary Sin Buzon');
        cleanupOrgIds.push(orgEmptyId);

        orgBrokenId = await createOrg('Org Pruebas Inbox Summary Buzon Roto');
        cleanupOrgIds.push(orgBrokenId);
        const createdBroken = await validateAndSaveAccount(orgBrokenId, {
            emailAddress: `buzon-roto-${crypto.randomUUID()}@example.invalid`,
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
        if (!createdBroken.success) throw new Error(`No se pudo crear el buzón roto de prueba: ${createdBroken.error}`);
        brokenAccountId = createdBroken.account.id;
        await supabaseAdmin
            .from('email_accounts')
            .update({ status: 'error', last_error: 'Falló la autenticación con el servidor IMAP.' })
            .eq('id', brokenAccountId);
    });

    afterAll(async () => {
        for (const id of [accountId, brokenAccountId]) {
            const { data: row } = await supabaseAdmin.from('email_accounts').select('vault_secret_id').eq('id', id).maybeSingle();
            if (row?.vault_secret_id) await deleteAccountCredentials(row.vault_secret_id as string);
        }
        for (const org of cleanupOrgIds) {
            await supabaseAdmin.from('email_outbox').delete().eq('organization_id', org);
            await supabaseAdmin.from('email_accounts').delete().eq('organization_id', org);
            await supabaseAdmin.from('organizations').delete().eq('id', org);
        }
    });

    beforeEach(() => {
        imapShouldFail = false;
        mockStatus = { messages: 0, unseen: 0 };
        mockSearchUids = [];
        mockEnvelope = {};
        connectCallCount = 0;
        clearInboxSummaryCache();
    });

    it('rechaza con 401 sin autenticación de plataforma', async () => {
        const app = await buildTestApp();
        const response = await app.inject({ method: 'GET', url: `/api/admin/email-accounts/organization/${orgId}/inbox-summary` });
        expect(response.statusCode).toBe(401);
        await app.close();
    });

    it('sin buzón vinculado: devuelve 200 con métricas en cero y mensajes vacíos', async () => {
        const app = await buildTestApp();
        const response = await app.inject({
            method: 'GET',
            url: `/api/admin/email-accounts/organization/${orgEmptyId}/inbox-summary`,
            headers: { 'x-platform-admin': 'true' },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.unreadCount).toBe(0);
        expect(body.draftsCount).toBe(0);
        expect(body.errorsCount).toBe(0);
        expect(body.sentCount).toBe(0);
        expect(body.totalMessages).toBe(0);
        expect(body.lastSyncedAt).toBeNull();
        expect(body.messages).toEqual([]);
        await app.close();
    });

    it('contraparte de éxito: buzón activo con no leídos devuelve conteo y lista consolidada', async () => {
        mockStatus = { messages: 13, unseen: 2 };
        mockSearchUids = [101, 102];
        mockEnvelope = { subject: 'Asunto de prueba', from: [{ address: 'remitente@example.invalid', name: 'Remitente Prueba' }], date: '2026-08-17T14:30:00Z' };

        await insertOutboxRow(orgId, accountId, 'draft');
        await insertOutboxRow(orgId, accountId, 'sent');
        await insertOutboxRow(orgId, accountId, 'failed', { error_message: 'El servidor SMTP rechazó el mensaje.' });

        const app = await buildTestApp();
        const response = await app.inject({
            method: 'GET',
            url: `/api/admin/email-accounts/organization/${orgId}/inbox-summary`,
            headers: { 'x-platform-admin': 'true' },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();

        expect(body.unreadCount).toBe(2);
        expect(body.totalMessages).toBe(13);
        expect(body.draftsCount).toBe(1);
        expect(body.sentCount).toBe(1);
        expect(body.errorsCount).toBe(1);
        expect(body.stats).toEqual({ unreadCount: 2, draftsCount: 1, errorsCount: 1, sentCount: 1 });
        expect(body.lastSyncedAt).not.toBeNull();

        const unreadTasks = body.messages.filter((m: { category: string }) => m.category === 'unread');
        expect(unreadTasks).toHaveLength(2);
        expect(unreadTasks[0].fromName).toBe('Remitente Prueba');
        expect(unreadTasks[0].from).toBe('remitente@example.invalid');

        const draftTasks = body.messages.filter((m: { category: string }) => m.category === 'draft');
        expect(draftTasks).toHaveLength(1);

        const errorTasks = body.messages.filter((m: { category: string }) => m.category === 'error');
        expect(errorTasks).toHaveLength(1);
        expect(errorTasks[0].snippet).toContain('El servidor SMTP rechazó el mensaje.');

        await app.close();
    });

    it('degrada con 200 si la conexión IMAP falla, conservando las métricas de la base de datos', async () => {
        imapShouldFail = true;
        const app = await buildTestApp();
        const response = await app.inject({
            method: 'GET',
            url: `/api/admin/email-accounts/organization/${orgId}/inbox-summary`,
            headers: { 'x-platform-admin': 'true' },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.unreadCount).toBe(0);
        expect(body.totalMessages).toBe(0);
        expect(body.lastSyncedAt).toBeNull();
        // Las métricas de email_outbox (creadas en el test anterior) no dependen de IMAP.
        expect(body.draftsCount).toBeGreaterThanOrEqual(1);

        const { data: row } = await supabaseAdmin.from('email_accounts').select('last_error').eq('id', accountId).maybeSingle();
        expect(row?.last_error).toContain('Simulated IMAP connection failure');
        await app.close();
    });

    it('buzón en estado error: suma 1 a errorsCount y agrega una tarea de buzón desconectado', async () => {
        const app = await buildTestApp();
        const response = await app.inject({
            method: 'GET',
            url: `/api/admin/email-accounts/organization/${orgBrokenId}/inbox-summary`,
            headers: { 'x-platform-admin': 'true' },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.unreadCount).toBe(0);
        expect(body.errorsCount).toBe(1);

        const errorTasks = body.messages.filter((m: { category: string }) => m.category === 'error');
        expect(errorTasks).toHaveLength(1);
        expect(errorTasks[0].subject).toBe('Buzón desconectado');
        expect(errorTasks[0].snippet).toContain('Falló la autenticación');
        await app.close();
    });

    it('caché de 60s: dos peticiones seguidas no vuelven a abrir una conexión IMAP', async () => {
        mockStatus = { messages: 5, unseen: 1 };
        mockSearchUids = [201];
        mockEnvelope = { subject: 'Correo único', from: [{ address: 'otro@example.invalid' }] };

        const app = await buildTestApp();
        const first = await app.inject({
            method: 'GET',
            url: `/api/admin/email-accounts/organization/${orgId}/inbox-summary`,
            headers: { 'x-platform-admin': 'true' },
        });
        const second = await app.inject({
            method: 'GET',
            url: `/api/admin/email-accounts/organization/${orgId}/inbox-summary`,
            headers: { 'x-platform-admin': 'true' },
        });

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expect(second.json().lastSyncedAt).toBe(first.json().lastSyncedAt);
        expect(connectCallCount).toBe(1);
        await app.close();
    });

    it('aislamiento multi-tenant: los borradores de una organización no aparecen en el resumen de otra', async () => {
        const app = await buildTestApp();
        const response = await app.inject({
            method: 'GET',
            url: `/api/admin/email-accounts/organization/${orgEmptyId}/inbox-summary`,
            headers: { 'x-platform-admin': 'true' },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.draftsCount).toBe(0);
        expect(body.messages).toEqual([]);
        await app.close();
    });
});
