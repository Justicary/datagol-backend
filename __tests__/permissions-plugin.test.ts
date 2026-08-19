import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import { requirePermission } from '../src/plugins/permissions.js';
import { PERMISSION_KEYS } from '../src/types/permission-keys.js';
import { ORGANIZATION_ROLES } from '../src/types/organization-roles.js';

const env = validateEnv();

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-perm-plugin-${crypto.randomUUID()}@example.invalid`;
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

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);

    app.get('/test/organizations/:id/costs', { preHandler: requirePermission(app, PERMISSION_KEYS.VIEW_COSTS) }, async (request) => {
        return { ok: true, permissions: Array.from(request.permissions ?? []) };
    });

    // Ruta deliberadamente sin `:id` en el patrón — requirePermission busca
    // el parámetro `paramName` ('id' por defecto) en request.params y no lo
    // encontrará, ejercitando la rama "falta el parámetro de organización".
    app.get('/test/no-org-param', { preHandler: requirePermission(app, PERMISSION_KEYS.VIEW_COSTS) }, async () => {
        return { ok: true };
    });

    await app.ready();
    return app;
}

describe('plugins/permissions.ts — requirePermission', () => {
    let app: FastifyInstance;
    let owner: TestUser;
    let viewer: TestUser;
    let outsider: TestUser;
    let orgId: string;

    beforeAll(async () => {
        app = await buildTestApp();
        owner = await createTestUserWithJwt();
        viewer = await createTestUserWithJwt();
        outsider = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Permissions Plugin Test Org',
            p_email: `perm-plugin-test-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`Setup falló creando organización: ${error?.message}`);
        orgId = org.id;

        const { error: memberErr } = await supabaseAdmin
            .from('organization_members')
            .insert({ organization_id: orgId, user_id: viewer.userId, role: ORGANIZATION_ROLES.VIEWER });
        if (memberErr) throw new Error(`Setup falló agregando viewer: ${memberErr.message}`);
    });

    afterAll(async () => {
        await app.close();
        await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await deleteTestUser(owner.userId);
        await deleteTestUser(viewer.userId);
        await deleteTestUser(outsider.userId);
    });

    it('un owner con el permiso pasa y recibe request.permissions poblado', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/test/organizations/${orgId}/costs`,
            headers: { authorization: `Bearer ${owner.jwt}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.permissions).toContain(PERMISSION_KEYS.VIEW_COSTS);
    });

    it('un viewer sin el permiso recibe 403 accionable', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/test/organizations/${orgId}/costs`,
            headers: { authorization: `Bearer ${viewer.jwt}` },
        });
        expect(res.statusCode).toBe(403);
        const body = res.json();
        expect(body.code).toBe('PERMISSION_DENIED');
        expect(body.message).toContain(PERMISSION_KEYS.VIEW_COSTS);
    });

    it('un usuario que no pertenece a la organización también recibe 403 (no 500 ni fuga de datos)', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/test/organizations/${orgId}/costs`,
            headers: { authorization: `Bearer ${outsider.jwt}` },
        });
        expect(res.statusCode).toBe(403);
    });

    it('sin token de autenticación, 401', async () => {
        const res = await app.inject({ method: 'GET', url: `/test/organizations/${orgId}/costs` });
        expect(res.statusCode).toBe(401);
    });

    it('sin el parámetro de organización en la ruta, 400 antes de autenticar', async () => {
        const res = await app.inject({ method: 'GET', url: '/test/no-org-param' });
        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.success).toBe(false);
        expect(body.error).toBe('El parámetro de ruta "id" es obligatorio.');
    });
});
