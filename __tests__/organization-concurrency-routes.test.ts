import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationConcurrencyRoutes from '../src/routes/organization-concurrency.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(organizationConcurrencyRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-concurrency-${crypto.randomUUID()}@example.invalid`;
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

describe('GET /api/organizations/:id/concurrency', () => {
    let owner: TestUser;
    let outsider: TestUser;
    let orgId: string;
    let groupId: string;

    beforeAll(async () => {
        owner = await createTestUserWithJwt();
        outsider = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Org Concurrency Test',
            p_email: `concurrency-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`Setup falló: ${error?.message}`);
        orgId = org.id;

        const { data: orgRow, error: readErr } = await supabaseAdmin
            .from('organizations')
            .select('credential_group_id')
            .eq('id', orgId)
            .single();
        if (readErr || !orgRow) throw new Error(`No se pudo leer credential_group_id: ${readErr?.message}`);
        groupId = orgRow.credential_group_id;

        await supabaseAdmin.from('credential_groups').update({ elevenlabs_plan_key: 'pro' }).eq('id', groupId);
        await supabaseAdmin.from('organization_concurrency_quota').insert({ organization_id: orgId, soft_limit: 10 });
    });

    afterAll(async () => {
        await supabaseAdmin.from('organization_concurrency_quota').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await deleteTestUser(owner.userId);
        await deleteTestUser(outsider.userId);
    });

    it('sin JWT → 401', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({ method: 'GET', url: `/api/organizations/${orgId}/concurrency` });
            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('un usuario que no pertenece a la organización recibe 403', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/concurrency`,
                headers: { authorization: `Bearer ${outsider.jwt}` },
            });
            expect(response.statusCode).toBe(403);
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: el owner ve el reparto de concurrencia de su grupo (v_concurrency_allocation)', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/concurrency`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.success).toBe(true);
            expect(body.data.credential_group_id).toBe(groupId);
            expect(body.data.plan).toBe('pro');
            expect(body.data.pozo_total).toBe(40); // max_concurrent del plan 'pro', migración 56 BLOQUE 1
            expect(body.data.cuotas_asignadas).toBe(10);
        } finally {
            await app.close();
        }
    });
});
