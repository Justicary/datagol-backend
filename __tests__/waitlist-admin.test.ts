import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import waitlistAdminRoutes from '../src/routes/waitlist-admin.js';
import { clearEntitlementsCache } from '../src/services/entitlements.js';
import { WAITLIST_STATUSES } from '../src/types/waitlist.js';

const env = validateEnv();

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(waitlistAdminRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-waitlist-admin-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createErr || !created.user) throw new Error(`No se pudo crear el usuario de prueba: ${createErr?.message}`);

    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) throw new Error(`No se pudo iniciar sesión de prueba: ${signInErr?.message}`);

    return { userId: created.user.id, jwt: session.session.access_token };
}

describe('GET /api/organizations/:id/waitlist', () => {
    let owner: TestUser;
    let outsider: TestUser;
    let orgId: string;
    const createdWaitlistIds: string[] = [];

    beforeAll(async () => {
        owner = await createTestUserWithJwt();
        outsider = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Waitlist Admin Test Org',
            p_email: `waitlist-admin-test-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`Setup falló creando organización: ${error?.message}`);
        orgId = org.id;

        const { error: featureErr } = await supabaseAdmin
            .from('organization_features')
            .insert({ organization_id: orgId, feature_key: 'waitlist', enabled: true, reason: 'waitlist-admin.test.ts' });
        if (featureErr) throw new Error(`Setup falló habilitando feature waitlist: ${featureErr.message}`);
        clearEntitlementsCache();

        const rows = [
            { status: WAITLIST_STATUSES.PENDIENTE, priority: 'normal' },
            { status: WAITLIST_STATUSES.OFERTADA, priority: 'alta' },
            { status: WAITLIST_STATUSES.CONFIRMADA, priority: 'normal' },
            { status: WAITLIST_STATUSES.CANCELADA, priority: 'baja' },
        ];
        for (const row of rows) {
            const slotStart = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
            const { data, error: insertErr } = await supabaseAdmin
                .from('appointment_waitlist')
                .insert({
                    organization_id: orgId,
                    customer_name: `Cliente ${row.status}`,
                    customer_phone: `+5255${Math.floor(Math.random() * 90000000 + 10000000)}`,
                    preferred_date_start: slotStart.slice(0, 10),
                    preferred_date_end: slotStart.slice(0, 10),
                    status: row.status,
                    priority: row.priority,
                })
                .select('id')
                .single();
            if (insertErr || !data) throw new Error(`No se pudo crear fila de prueba: ${insertErr?.message}`);
            createdWaitlistIds.push(data.id);
        }
    });

    afterAll(async () => {
        if (createdWaitlistIds.length) {
            await supabaseAdmin.from('appointment_waitlist').delete().in('id', createdWaitlistIds);
        }
        await supabaseAdmin.from('organization_features').delete().eq('organization_id', orgId).eq('feature_key', 'waitlist');
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await supabaseAdmin.auth.admin.deleteUser(owner.userId);
        await supabaseAdmin.auth.admin.deleteUser(outsider.userId);
        clearEntitlementsCache();
    });

    it('sin autenticación responde 401', async () => {
        const app = await buildTestApp();
        const res = await app.inject({ method: 'GET', url: `/api/organizations/${orgId}/waitlist` });
        expect(res.statusCode).toBe(401);
        await app.close();
    });

    it('un usuario ajeno a la organización no puede listar (RBAC)', async () => {
        const app = await buildTestApp();
        const res = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/waitlist`,
            headers: { authorization: `Bearer ${outsider.jwt}` },
        });
        expect(res.statusCode).toBe(403);
        await app.close();
    });

    it('por defecto solo devuelve la cola activa (pendiente + ofertada)', async () => {
        const app = await buildTestApp();
        const res = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/waitlist`,
            headers: { authorization: `Bearer ${owner.jwt}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.success).toBe(true);
        expect(body.data.total).toBe(2);
        const statuses = body.data.items.map((i: any) => i.status).sort();
        expect(statuses).toEqual([WAITLIST_STATUSES.OFERTADA, WAITLIST_STATUSES.PENDIENTE].sort());
        await app.close();
    });

    it('status=confirmada,cancelada filtra por historial explícito', async () => {
        const app = await buildTestApp();
        const res = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/waitlist?status=confirmada,cancelada`,
            headers: { authorization: `Bearer ${owner.jwt}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.data.total).toBe(2);
        const statuses = body.data.items.map((i: any) => i.status).sort();
        expect(statuses).toEqual([WAITLIST_STATUSES.CANCELADA, WAITLIST_STATUSES.CONFIRMADA].sort());
        await app.close();
    });

    it('un status inválido responde 400', async () => {
        const app = await buildTestApp();
        const res = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/waitlist?status=no_existe`,
            headers: { authorization: `Bearer ${owner.jwt}` },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
    });

    it('sin la feature waitlist habilitada responde 403 con requiredFeature', async () => {
        await supabaseAdmin.from('organization_features').update({ enabled: false }).eq('organization_id', orgId).eq('feature_key', 'waitlist');
        clearEntitlementsCache();

        const app = await buildTestApp();
        const res = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/waitlist`,
            headers: { authorization: `Bearer ${owner.jwt}` },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().requiredFeature).toBe('waitlist');
        await app.close();

        await supabaseAdmin.from('organization_features').update({ enabled: true }).eq('organization_id', orgId).eq('feature_key', 'waitlist');
        clearEntitlementsCache();
    });
});
