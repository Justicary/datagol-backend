import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import sendTemplateEmailRoutes from '../src/routes/send-template-email.js';
import { ORGANIZATION_ROLES } from '../src/types/organization-roles.js';
import { storeAccountCredentials, deleteAccountCredentials } from '../src/services/email/email-account-vault.js';

const env = validateEnv();

async function buildTestApp(): Promise<{ app: FastifyInstance; sendSpy: ReturnType<typeof vi.fn> }> {
    const sendSpy = vi.fn().mockResolvedValue('fake-pgboss-job-id');
    // Doble de prueba de fastify.pgBoss (mismo patrón que
    // __tests__/webhooks-elevenlabs.test.ts) — evita depender de un pg-boss
    // real corriendo solo para verificar que se encoló el job correcto.
    const fakeQueuePlugin = fp(async (fastify) => {
        fastify.decorate('pgBoss', { send: sendSpy } as unknown as FastifyInstance['pgBoss']);
    });

    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(fakeQueuePlugin);
    await app.register(sendTemplateEmailRoutes);
    await app.ready();
    return { app, sendSpy };
}

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-send-template-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createErr || !created.user) throw new Error(`No se pudo crear el usuario de prueba: ${createErr?.message}`);

    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) throw new Error(`No se pudo iniciar sesión de prueba: ${signInErr?.message}`);

    return { userId: created.user.id, jwt: session.session.access_token };
}

async function deleteTestUser(userId: string): Promise<void> {
    await supabaseAdmin.auth.admin.deleteUser(userId);
}

function randomMxPhone(): string {
    return `+5255${Math.floor(Math.random() * 90000000 + 10000000)}`;
}

describe('POST /api/organizations/:orgId/email/send-template', () => {
    let app: FastifyInstance;
    let sendSpy: ReturnType<typeof vi.fn>;
    let owner: TestUser;
    let viewer: TestUser;
    let orgId: string;
    let emailAccountId: string;
    let vaultSecretId: string;
    let optedInContactId: string;
    let optedOutContactId: string;
    let noEmailContactId: string;

    beforeAll(async () => {
        ({ app, sendSpy } = await buildTestApp());
        owner = await createTestUserWithJwt();
        viewer = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Send Template Email Test Org',
            p_email: `send-template-test-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`Setup falló creando organización: ${error?.message}`);
        orgId = org.id;

        await supabaseAdmin.from('organizations').update({ plan_key: 'elite' }).eq('id', orgId);
        const { error: memberErr } = await supabaseAdmin
            .from('organization_members')
            .insert({ organization_id: orgId, user_id: viewer.userId, role: ORGANIZATION_ROLES.VIEWER });
        if (memberErr) throw new Error(`Setup falló agregando viewer: ${memberErr.message}`);

        // Buzón emisor insertado directo (sin pasar por verificación IMAP/SMTP
        // real) — esta suite no ejercita el envío SMTP en sí, solo que las
        // filas de email_outbox se insertan y se encola un job por cada una.
        emailAccountId = crypto.randomUUID();
        const storedSecretId = await storeAccountCredentials(orgId, emailAccountId, { imapPassword: 'x', smtpPassword: 'x' });
        if (!storedSecretId) throw new Error('Setup falló guardando credenciales en Vault');
        vaultSecretId = storedSecretId;

        const { error: accountErr } = await supabaseAdmin.from('email_accounts').insert({
            id: emailAccountId,
            organization_id: orgId,
            email_address: `buzon-send-template-${crypto.randomUUID()}@example.invalid`,
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
        if (accountErr) throw new Error(`Setup falló creando email_accounts: ${accountErr.message}`);

        const { data: c1, error: c1Err } = await supabaseAdmin.rpc('resolve_contact', {
            p_org_id: orgId,
            p_phone: randomMxPhone(),
            p_email: `contacto-valido-${crypto.randomUUID()}@example.invalid`,
        });
        if (c1Err || !c1) throw new Error(`Setup falló creando contacto válido: ${c1Err?.message}`);
        optedInContactId = c1;
        await supabaseAdmin.from('contacts').update({ full_name: 'Juan Pérez', business_name: 'Acme Corp' }).eq('id', optedInContactId);

        const { data: c2, error: c2Err } = await supabaseAdmin.rpc('resolve_contact', {
            p_org_id: orgId,
            p_phone: randomMxPhone(),
            p_email: `contacto-opted-out-${crypto.randomUUID()}@example.invalid`,
        });
        if (c2Err || !c2) throw new Error(`Setup falló creando contacto opted_out: ${c2Err?.message}`);
        optedOutContactId = c2;
        await supabaseAdmin.from('contacts').update({ opted_out: true, opted_out_at: new Date().toISOString() }).eq('id', optedOutContactId);

        const { data: c3, error: c3Err } = await supabaseAdmin.rpc('resolve_contact', {
            p_org_id: orgId,
            p_phone: randomMxPhone(),
            p_email: null,
        });
        if (c3Err || !c3) throw new Error(`Setup falló creando contacto sin email: ${c3Err?.message}`);
        noEmailContactId = c3;
    });

    afterAll(async () => {
        await app.close();
        await supabaseAdmin.from('email_outbox').delete().eq('organization_id', orgId);
        await deleteAccountCredentials(vaultSecretId);
        await supabaseAdmin.from('email_accounts').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('contacts').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await deleteTestUser(owner.userId);
        await deleteTestUser(viewer.userId);
    });

    beforeEach(() => {
        sendSpy.mockClear();
    });

    it('rechaza con 401 sin autenticación', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/email/send-template`,
            payload: { emailAccountId, contactIds: [optedInContactId], subject: 'x', bodyMarkdown: 'y' },
        });
        expect(res.statusCode).toBe(401);
    });

    it('rechaza con 403 si el usuario no tiene edit_contacts (viewer)', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/email/send-template`,
            headers: { authorization: `Bearer ${viewer.jwt}` },
            payload: { emailAccountId, contactIds: [optedInContactId], subject: 'x', bodyMarkdown: 'y' },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().requiredPermission).toBe('edit_contacts');
        expect(sendSpy).not.toHaveBeenCalled();
    });

    it('rechaza con 400 si contactIds está vacío', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/email/send-template`,
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: { emailAccountId, contactIds: [], subject: 'x', bodyMarkdown: 'y' },
        });
        expect(res.statusCode).toBe(400);
    });

    it('rechaza con 404 si el emailAccountId no pertenece a la organización', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/email/send-template`,
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: { emailAccountId: crypto.randomUUID(), contactIds: [optedInContactId], subject: 'x', bodyMarkdown: 'y' },
        });
        expect(res.statusCode).toBe(404);
    });

    it('rechaza con 400 si un adjunto no es un archivo válido (magic bytes)', async () => {
        const fakePdfContent = Buffer.from('esto no es un pdf real');
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/email/send-template`,
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: {
                emailAccountId,
                contactIds: [optedInContactId],
                subject: 'x',
                bodyMarkdown: 'y',
                attachments: [
                    {
                        filename: 'catalogo.pdf',
                        contentType: 'application/pdf',
                        contentBase64: fakePdfContent.toString('base64'),
                        sizeBytes: fakePdfContent.length,
                    },
                ],
            },
        });
        expect(res.statusCode).toBe(400);
        expect(sendSpy).not.toHaveBeenCalled();
    });

    it('contraparte de éxito: filtra opted_out y sin-email, interpola variables, inserta drafts y encola un job por cada uno', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/email/send-template`,
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: {
                emailAccountId,
                contactIds: [optedInContactId, optedOutContactId, noEmailContactId],
                subject: 'Hola {primer_nombre} de {mi_empresa}',
                bodyMarkdown: 'Un gusto hablar contigo sobre {empresa}, **saludos**.',
            },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.success).toBe(true);
        expect(body.data.totalRequested).toBe(3);
        expect(body.data.queued).toBe(1);
        expect(body.data.skippedOptedOut).toBe(1);
        expect(body.data.skippedNoEmail).toBe(1);
        expect(body.data.outboxIds).toHaveLength(1);
        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy).toHaveBeenCalledWith('send-template-email', { outboxId: body.data.outboxIds[0] });

        const { data: row } = await supabaseAdmin
            .from('email_outbox')
            .select('subject, status, contact_id, body_html')
            .eq('id', body.data.outboxIds[0])
            .single();
        expect(row?.status).toBe('draft');
        expect(row?.contact_id).toBe(optedInContactId);
        expect(row?.subject).toContain('Juan');
        expect(row?.body_html).toContain('Acme Corp');
        expect(row?.body_html).toContain('<strong>saludos</strong>');
    });

    it('idempotencia: reenviar el mismo lote de contenido dentro de la misma hora no duplica filas ni re-encola', async () => {
        const payload = {
            emailAccountId,
            contactIds: [optedInContactId],
            subject: 'Asunto idempotente de prueba',
            bodyMarkdown: 'Cuerpo idempotente de prueba',
        };

        const first = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/email/send-template`,
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload,
        });
        expect(first.statusCode).toBe(200);
        expect(sendSpy).toHaveBeenCalledTimes(1);

        const second = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/email/send-template`,
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload,
        });
        expect(second.statusCode).toBe(200);

        expect(second.json().data.outboxIds[0]).toBe(first.json().data.outboxIds[0]);
        // El segundo request reusa la fila existente — no inserta una nueva
        // ni vuelve a encolar el job de envío.
        expect(sendSpy).toHaveBeenCalledTimes(1);

        const { data: rows } = await supabaseAdmin.from('email_outbox').select('id').eq('organization_id', orgId).eq('subject', payload.subject);
        expect(rows?.length).toBe(1);
    });
});
