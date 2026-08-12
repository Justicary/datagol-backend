import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationWidgetRoutes from '../src/routes/organization-widget.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(organizationWidgetRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
}

/**
 * Mismo patrón que __tests__/organization-onboarding.test.ts: usuario y JWT
 * reales de Supabase Auth — el único modo de ejercitar de verdad
 * `fastify.supabaseUser(jwt)` y la política RLS `org_self_access` real.
 */
async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-widget-admin-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
    });
    if (createErr || !created.user) {
        throw new Error(`No se pudo crear el usuario de prueba: ${createErr?.message}`);
    }

    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) {
        throw new Error(`No se pudo iniciar sesión de prueba: ${signInErr?.message}`);
    }

    return { userId: created.user.id, jwt: session.session.access_token };
}

async function deleteTestUser(userId: string): Promise<void> {
    await supabaseAdmin.auth.admin.deleteUser(userId);
}

async function deleteTestOrganization(organizationId: string): Promise<void> {
    await supabaseAdmin.from('widget_origins').delete().eq('organization_id', organizationId);
    await supabaseAdmin.from('organization_members').delete().eq('organization_id', organizationId);
    await supabaseAdmin.from('organizations').delete().eq('id', organizationId);
}

describe('routes/organization-widget.ts', () => {
    let owner: TestUser;
    let outsider: TestUser;
    let organizationId: string;

    beforeAll(async () => {
        owner = await createTestUserWithJwt();
        outsider = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Org Widget Admin Test',
            p_email: `widget-admin-org-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`No se pudo crear la organización de prueba: ${error?.message}`);
        organizationId = org.id;
    });

    afterAll(async () => {
        await deleteTestOrganization(organizationId);
        await deleteTestUser(owner.userId);
        await deleteTestUser(outsider.userId);
    });

    describe('POST /api/organizations/:id/widget-origins', () => {
        it('sin JWT → 401', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${organizationId}/widget-origins`,
                    payload: { origin: 'https://cliente.com' },
                });
                expect(response.statusCode).toBe(401);
            } finally {
                await app.close();
            }
        });

        it('un usuario que no pertenece a la organización → 403', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${organizationId}/widget-origins`,
                    headers: { authorization: `Bearer ${outsider.jwt}` },
                    payload: { origin: 'https://cliente.com' },
                });
                expect(response.statusCode).toBe(403);
            } finally {
                await app.close();
            }
        });

        it('rechaza con 400 un origin que no es una URL válida', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${organizationId}/widget-origins`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { origin: 'no-es-una-url' },
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: el owner registra un origen, normalizado y con public_key generada', async () => {
            const app = await buildTestApp();
            let createdId: string | undefined;
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${organizationId}/widget-origins`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { origin: 'https://Cliente.com/ruta/sobrante?query=1' },
                });
                expect(response.statusCode).toBe(201);
                const body = response.json();
                expect(body.success).toBe(true);
                expect(body.data.origin).toBe('https://cliente.com');
                expect(body.data.publicKey).toMatch(/^pk_[0-9a-f]{48}$/);
                expect(body.data.enabled).toBe(true);
                createdId = body.data.id;
            } finally {
                await app.close();
                if (createdId) await supabaseAdmin.from('widget_origins').delete().eq('id', createdId);
            }
        });

        it('rechaza con 409 un origen duplicado para la misma organización', async () => {
            const app = await buildTestApp();
            let createdId: string | undefined;
            try {
                const first = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${organizationId}/widget-origins`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { origin: 'https://duplicado.example.com' },
                });
                createdId = first.json().data.id;

                const second = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${organizationId}/widget-origins`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { origin: 'https://duplicado.example.com' },
                });
                expect(second.statusCode).toBe(409);
            } finally {
                await app.close();
                if (createdId) await supabaseAdmin.from('widget_origins').delete().eq('id', createdId);
            }
        });
    });

    describe('GET/PATCH/DELETE /api/organizations/:id/widget-origins/:originId', () => {
        it('lista, deshabilita y elimina el origen creado, de punta a punta', async () => {
            const app = await buildTestApp();
            let originId: string | undefined;
            try {
                const created = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${organizationId}/widget-origins`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { origin: 'https://e2e.example.com' },
                });
                originId = created.json().data.id;

                const list = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${organizationId}/widget-origins`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(list.statusCode).toBe(200);
                expect(list.json().data.some((o: any) => o.id === originId)).toBe(true);

                const patched = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${organizationId}/widget-origins/${originId}`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { enabled: false },
                });
                expect(patched.statusCode).toBe(200);
                expect(patched.json().data.enabled).toBe(false);

                const deleted = await app.inject({
                    method: 'DELETE',
                    url: `/api/organizations/${organizationId}/widget-origins/${originId}`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(deleted.statusCode).toBe(200);

                const afterDelete = await app.inject({
                    method: 'DELETE',
                    url: `/api/organizations/${organizationId}/widget-origins/${originId}`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(afterDelete.statusCode).toBe(404);
                originId = undefined;
            } finally {
                await app.close();
                if (originId) await supabaseAdmin.from('widget_origins').delete().eq('id', originId);
            }
        });

        it('un usuario ajeno no puede deshabilitar ni borrar el origen de otra organización', async () => {
            const app = await buildTestApp();
            let originId: string | undefined;
            try {
                const created = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${organizationId}/widget-origins`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { origin: 'https://aislamiento.example.com' },
                });
                originId = created.json().data.id;

                const patched = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${organizationId}/widget-origins/${originId}`,
                    headers: { authorization: `Bearer ${outsider.jwt}` },
                    payload: { enabled: false },
                });
                expect(patched.statusCode).toBe(403);

                const { data: stillEnabled } = await supabaseAdmin
                    .from('widget_origins')
                    .select('enabled')
                    .eq('id', originId)
                    .maybeSingle();
                expect(stillEnabled?.enabled).toBe(true);
            } finally {
                await app.close();
                if (originId) await supabaseAdmin.from('widget_origins').delete().eq('id', originId);
            }
        });
    });

    describe('GET/PATCH /api/organizations/:id/widget-settings', () => {
        it('contraparte de éxito: lee y actualiza el tope diario de sesiones del widget', async () => {
            const app = await buildTestApp();
            try {
                const before = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${organizationId}/widget-settings`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(before.statusCode).toBe(200);
                expect(before.json().data.dailySessionLimit).toBe(200);

                const updated = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${organizationId}/widget-settings`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { dailySessionLimit: 50 },
                });
                expect(updated.statusCode).toBe(200);
                expect(updated.json().data.dailySessionLimit).toBe(50);
            } finally {
                await supabaseAdmin.from('organizations').update({ widget_daily_session_limit: 200 }).eq('id', organizationId);
                await app.close();
            }
        });

        it('rechaza con 400 un dailySessionLimit no positivo', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${organizationId}/widget-settings`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { dailySessionLimit: 0 },
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });
    });
});
