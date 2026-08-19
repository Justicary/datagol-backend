import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationRoutes from '../src/routes/organization.js';
import { ORGANIZATION_ROLES } from '../src/types/organization-roles.js';
import { PERMISSION_KEYS } from '../src/types/permission-keys.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(organizationRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-org-agent-${crypto.randomUUID()}@example.invalid`;
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

/**
 * RBAC B.3 (docs/tasks/RBAC-permisos.md): routes/organization.ts era el
 * único archivo del repo sin ningún chequeo de autenticación — cualquier
 * visitante sin sesión podía leer/escribir el prompt del agente y la base
 * de conocimiento de CUALQUIER organización, y listar todas las
 * organizaciones. Esta prueba fija ese agujero.
 */
describe('routes/organization.ts — RBAC configure_agent (agujero sin autenticación)', () => {
    let app: FastifyInstance;
    let owner: TestUser;
    let member: TestUser;
    let orgId: string;

    beforeAll(async () => {
        app = await buildTestApp();
        owner = await createTestUserWithJwt();
        member = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Agent RBAC Test Org',
            p_email: `agent-rbac-test-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`Setup falló creando organización: ${error?.message}`);
        orgId = org.id;

        const { error: memberErr } = await supabaseAdmin
            .from('organization_members')
            .insert({ organization_id: orgId, user_id: member.userId, role: ORGANIZATION_ROLES.MEMBER });
        if (memberErr) throw new Error(`Setup falló agregando member: ${memberErr.message}`);
    });

    afterAll(async () => {
        await app.close();
        await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await deleteTestUser(owner.userId);
        await deleteTestUser(member.userId);
    });

    it('PATCH /:id/agent sin token → 401 (antes no exigía ninguna autenticación)', async () => {
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/organizations/${orgId}/agent`,
            payload: { systemPrompt: 'Prompt malicioso inyectado sin sesión' },
        });
        expect(res.statusCode).toBe(401);
    });

    it('PATCH /:id/agent con un member (sin configure_agent) → 403', async () => {
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/organizations/${orgId}/agent`,
            headers: { authorization: `Bearer ${member.jwt}` },
            payload: { systemPrompt: 'intento de member' },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().requiredPermission).toBe(PERMISSION_KEYS.CONFIGURE_AGENT);
    });

    it('PATCH /:id/agent con el owner pasa el gate de autorización (configure_agent concedido)', async () => {
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/organizations/${orgId}/agent`,
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: { systemPrompt: 'Prompt legítimo del owner' },
        });
        // No se afirma 200: sin VAPI_PRIVATE_KEY real en el entorno de
        // pruebas la llamada al proveedor puede degradar, pero NUNCA debe
        // ser 401/403 — lo único que esta prueba verifica es la autorización.
        expect(res.statusCode).not.toBe(401);
        expect(res.statusCode).not.toBe(403);
    });

    it('POST /:id/knowledge sin token → 401', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/knowledge`,
            payload: { title: 't', content: 'c' },
        });
        expect(res.statusCode).toBe(401);
    });

    it('GET /api/organizations (listado global) sin token de superadmin → 401', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/organizations' });
        expect(res.statusCode).toBe(401);
    });
});
