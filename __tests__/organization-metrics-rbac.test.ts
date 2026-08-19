import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationMetricsRoutes from '../src/routes/organization-metrics.js';
import { ORGANIZATION_ROLES } from '../src/types/organization-roles.js';
import { PERMISSION_KEYS } from '../src/types/permission-keys.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(organizationMetricsRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-metrics-rbac-${crypto.randomUUID()}@example.invalid`;
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
 * RBAC B.5 (docs/tasks/RBAC-permisos.md): "un member recibe 403 al
 * consultar costos" — el permiso análogo verificado a nivel de ruta real es
 * `view_revenue` sobre GET /business-results (view_costs no tiene hoy un
 * endpoint de organización propio; ver services/permission-service.test.ts
 * para la cobertura directa de view_costs sobre el conjunto de permisos).
 */
describe('routes/organization-metrics.ts — RBAC view_revenue', () => {
    let app: FastifyInstance;
    let owner: TestUser;
    let member: TestUser;
    let orgId: string;

    beforeAll(async () => {
        app = await buildTestApp();
        owner = await createTestUserWithJwt();
        member = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Metrics RBAC Test Org',
            p_email: `metrics-rbac-test-${crypto.randomUUID()}@example.invalid`,
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

    it('un member recibe 403 al consultar business-results (view_revenue)', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/business-results`,
            headers: { authorization: `Bearer ${member.jwt}` },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().requiredPermission).toBe(PERMISSION_KEYS.VIEW_REVENUE);
    });

    it('un owner sí puede consultar business-results', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/business-results`,
            headers: { authorization: `Bearer ${owner.jwt}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().success).toBe(true);
    });
});
