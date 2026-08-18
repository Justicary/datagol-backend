import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationCompetitorSitesRoutes from '../src/routes/organization-competitor-sites.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(organizationCompetitorSitesRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-competitor-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
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

describe('Rutas HTTP de sitios de competencia (organization-competitor-sites.ts)', () => {
    let app: FastifyInstance;
    let owner: TestUser;
    let member: TestUser;
    let outsider: TestUser;
    let orgId: string;

    beforeAll(async () => {
        app = await buildTestApp();
        [owner, member, outsider] = await Promise.all([createTestUserWithJwt(), createTestUserWithJwt(), createTestUserWithJwt()]);

        const { data: org, error: orgErr } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Org Competencia Test',
            p_email: `org-competitor-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: '+525512345678',
            p_user_id: owner.userId,
        });
        if (orgErr || !org) throw new Error(`No se pudo crear la organización de prueba: ${orgErr?.message}`);
        orgId = org.id;

        const { error: memberErr } = await supabaseAdmin
            .from('organization_members')
            .insert({ organization_id: orgId, user_id: member.userId, role: 'member' });
        if (memberErr) throw new Error(`No se pudo agregar al miembro de prueba: ${memberErr.message}`);
    });

    afterAll(async () => {
        await app.close();
        await supabaseAdmin.from('competitor_sites').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await Promise.all([owner, member, outsider].map((u) => supabaseAdmin.auth.admin.deleteUser(u.userId)));
    });

    describe('GET /api/organizations/:id/competitor-sites', () => {
        it('un miembro puede listar (aunque esté vacío)', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/competitor-sites`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toMatchObject({ success: true, data: [] });
        });

        it('un no-miembro recibe 403', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/competitor-sites`,
                headers: { authorization: `Bearer ${outsider.jwt}` },
            });
            expect(res.statusCode).toBe(403);
        });
    });

    describe('POST /api/organizations/:id/competitor-sites', () => {
        it('un miembro sin rol admin/owner recibe 403', async () => {
            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/competitor-sites`,
                headers: { authorization: `Bearer ${member.jwt}`, 'content-type': 'application/json' },
                payload: { url: 'https://competidor1.example.com' },
            });
            expect(res.statusCode).toBe(403);
        });

        it('contraparte de éxito: el owner puede crear hasta 3 sitios, el 4º se rechaza con 422', async () => {
            for (const n of [1, 2, 3]) {
                const res = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/competitor-sites`,
                    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': 'application/json' },
                    payload: { url: `https://competidor${n}.example.com`, label: `Competidor ${n}` },
                });
                expect(res.statusCode).toBe(201);
            }

            const fourth = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/competitor-sites`,
                headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': 'application/json' },
                payload: { url: 'https://competidor4.example.com' },
            });
            expect(fourth.statusCode).toBe(422);

            const { count } = await supabaseAdmin
                .from('competitor_sites')
                .select('id', { count: 'exact', head: true })
                .eq('organization_id', orgId);
            expect(count).toBe(3);
        });

        it('rechaza una URL no http(s) con 400', async () => {
            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/competitor-sites`,
                headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': 'application/json' },
                payload: { url: 'ftp://competidor.example.com' },
            });
            expect(res.statusCode).toBe(400);
        });
    });

    describe('PATCH y DELETE /api/organizations/:id/competitor-sites/:siteId', () => {
        it('contraparte de éxito: el owner puede deshabilitar y luego eliminar un sitio', async () => {
            const { data: site } = await supabaseAdmin
                .from('competitor_sites')
                .select('id')
                .eq('organization_id', orgId)
                .limit(1)
                .single();

            const patchRes = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${orgId}/competitor-sites/${site!.id}`,
                headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': 'application/json' },
                payload: { enabled: false },
            });
            expect(patchRes.statusCode).toBe(200);
            expect(patchRes.json().data.enabled).toBe(false);

            const deleteRes = await app.inject({
                method: 'DELETE',
                url: `/api/organizations/${orgId}/competitor-sites/${site!.id}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(deleteRes.statusCode).toBe(200);
        });

        it('un no-miembro recibe 403 al intentar PATCH', async () => {
            const { data: site } = await supabaseAdmin
                .from('competitor_sites')
                .select('id')
                .eq('organization_id', orgId)
                .limit(1)
                .single();

            const res = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${orgId}/competitor-sites/${site!.id}`,
                headers: { authorization: `Bearer ${outsider.jwt}`, 'content-type': 'application/json' },
                payload: { enabled: false },
            });
            expect(res.statusCode).toBe(403);
        });
    });
});
