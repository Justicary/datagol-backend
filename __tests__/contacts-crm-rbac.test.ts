import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import contactsCrmRoutes from '../src/routes/contacts-crm.js';
import { ORGANIZATION_ROLES } from '../src/types/organization-roles.js';
import { LEAD_CHANNELS } from '../src/types/lead-enums.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(contactsCrmRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-crm-rbac-${crypto.randomUUID()}@example.invalid`;
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

/**
 * Cobertura de RBAC (docs/tasks/RBAC-permisos.md) sobre routes/contacts-crm.ts,
 * añadida sin tocar __tests__/contacts-crm.test.ts. Central: un viewer que
 * consulta el detalle de un contacto NO recibe la clave `transcript` (B.4).
 * Además cubre `close_deals` como acción distinta de `edit_contacts` (B.5).
 */
describe('routes/contacts-crm.ts — RBAC (B.4 redacción de transcript, B.5 close_deals)', () => {
    let app: FastifyInstance;
    let owner: TestUser;
    let member: TestUser;
    let viewer: TestUser;
    let orgId: string;
    let contactId: string;
    let callLogId: string;
    const secretTranscript = 'Cliente: quiero cancelar mi suscripción por el precio.';
    const secretSummary = 'Cliente insatisfecho con el precio, evaluar retención.';

    beforeAll(async () => {
        app = await buildTestApp();
        owner = await createTestUserWithJwt();
        member = await createTestUserWithJwt();
        viewer = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'CRM RBAC Test Org',
            p_email: `crm-rbac-test-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`Setup falló creando organización: ${error?.message}`);
        orgId = org.id;

        await supabaseAdmin.from('organizations').update({ plan_key: 'elite' }).eq('id', orgId);

        const { error: memberErr } = await supabaseAdmin.from('organization_members').insert([
            { organization_id: orgId, user_id: member.userId, role: ORGANIZATION_ROLES.MEMBER },
            { organization_id: orgId, user_id: viewer.userId, role: ORGANIZATION_ROLES.VIEWER },
        ]);
        if (memberErr) throw new Error(`Setup falló agregando miembros: ${memberErr.message}`);

        const { data: newContactId, error: contactErr } = await supabaseAdmin.rpc('resolve_contact', {
            p_org_id: orgId,
            p_phone: randomMxPhone(),
            p_email: null,
        });
        if (contactErr || !newContactId) throw new Error(`Setup falló creando contacto: ${contactErr?.message}`);
        contactId = newContactId;

        const { data: newCallLog, error: callLogErr } = await supabaseAdmin
            .from('call_logs')
            .insert({
                organization_id: orgId,
                transcript: secretTranscript,
                summary: secretSummary,
            })
            .select('id')
            .single();
        if (callLogErr || !newCallLog) throw new Error(`Setup falló creando call_log: ${callLogErr?.message}`);
        callLogId = newCallLog.id;

        const { error: leadErr } = await supabaseAdmin.from('leads').insert({
            organization_id: orgId,
            contact_id: contactId,
            channel: LEAD_CHANNELS.VOICE,
            conversation_id: `conv-${crypto.randomUUID()}`,
            call_log_id: callLogId,
        });
        if (leadErr) throw new Error(`Setup falló creando lead: ${leadErr.message}`);
    });

    afterAll(async () => {
        await app.close();
        await supabaseAdmin.from('call_logs').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('leads').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('contacts').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await deleteTestUser(owner.userId);
        await deleteTestUser(member.userId);
        await deleteTestUser(viewer.userId);
    });

    function conversationEntry(body: any) {
        return body.data.timeline.find((entry: any) => entry.type === 'conversation' && entry.data.call_log_id === callLogId);
    }

    it('un viewer que consulta el contacto NO recibe la clave transcript (ni summary)', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/contacts/${contactId}`,
            headers: { authorization: `Bearer ${viewer.jwt}` },
        });
        expect(res.statusCode).toBe(200);
        const entry = conversationEntry(res.json());
        expect(entry).toBeDefined();
        expect('transcript' in entry.data).toBe(false);
        expect('summary' in entry.data).toBe(false);
    });

    it('un member (con view_transcripts) SÍ recibe transcript/summary reales', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/contacts/${contactId}`,
            headers: { authorization: `Bearer ${member.jwt}` },
        });
        expect(res.statusCode).toBe(200);
        const entry = conversationEntry(res.json());
        expect(entry.data.transcript).toBe(secretTranscript);
        expect(entry.data.summary).toBe(secretSummary);
    });

    it('un member sin close_deals recibe 403 al marcar la etapa como ganado', async () => {
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/organizations/${orgId}/contacts/${contactId}/pipeline`,
            headers: { authorization: `Bearer ${member.jwt}` },
            payload: { pipelineStage: 'ganado' },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().requiredPermission).toBe('close_deals');
    });

    it('un owner con close_deals sí puede marcar la etapa como ganado', async () => {
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/organizations/${orgId}/contacts/${contactId}/pipeline`,
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: { pipelineStage: 'ganado', dealValue: 1500 },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().data.pipeline_stage).toBe('ganado');
    });

    it('un viewer sin edit_contacts recibe 403 al intentar editar el contacto', async () => {
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/organizations/${orgId}/contacts/${contactId}`,
            headers: { authorization: `Bearer ${viewer.jwt}` },
            payload: { fullName: 'Nuevo nombre' },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().requiredPermission).toBe('edit_contacts');
    });
});
