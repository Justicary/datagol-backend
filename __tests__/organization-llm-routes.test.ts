import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationLlmRoutes from '../src/routes/organization-llm.js';
import * as llmConfigService from '../src/services/llm-config-service.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(organizationLlmRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-llm-${crypto.randomUUID()}@example.invalid`;
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

describe('Rutas HTTP de configuración BYOK de LLM (organization-llm.ts)', () => {
    let app: FastifyInstance;
    let member: TestUser;
    let outsider: TestUser;
    let orgId: string;

    beforeAll(async () => {
        app = await buildTestApp();
        [member, outsider] = await Promise.all([createTestUserWithJwt(), createTestUserWithJwt()]);

        const { data: org, error: orgErr } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Org LLM BYOK Test',
            p_email: `org-llm-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: '+525512345678',
            p_user_id: member.userId,
        });
        if (orgErr || !org) {
            throw new Error(`No se pudo crear la organización de prueba: ${orgErr?.message}`);
        }
        orgId = org.id;
    });

    afterAll(async () => {
        await app.close();
        if (orgId) await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await Promise.all(
            [member, outsider].filter(Boolean).map((u) => supabaseAdmin.auth.admin.deleteUser(u.userId))
        );
    });

    describe('GET /api/organizations/:id/llm-config', () => {
        it('un miembro obtiene la config vacía inicial', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/llm-config`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toMatchObject({ success: true, data: { provider: null, model: null } });
        });

        it('un no-miembro recibe 403', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/llm-config`,
                headers: { authorization: `Bearer ${outsider.jwt}` },
            });
            expect(res.statusCode).toBe(403);
        });
    });

    describe('PATCH /api/organizations/:id/llm-config', () => {
        it('un miembro guarda provider/model válidos', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${orgId}/llm-config`,
                headers: { authorization: `Bearer ${member.jwt}`, 'content-type': 'application/json' },
                payload: { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731', baseUrl: 'https://openrouter.ai/api/v1' },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data).toMatchObject({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' });
        });

        it('rechaza openrouter sin baseUrl https (400)', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${orgId}/llm-config`,
                headers: { authorization: `Bearer ${member.jwt}`, 'content-type': 'application/json' },
                payload: { provider: 'openrouter', model: 'foo' },
            });
            expect(res.statusCode).toBe(400);
        });

        it('un no-miembro recibe 403', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${orgId}/llm-config`,
                headers: { authorization: `Bearer ${outsider.jwt}`, 'content-type': 'application/json' },
                payload: { provider: 'openai', model: 'gpt-4o-mini' },
            });
            expect(res.statusCode).toBe(403);
        });
    });

    describe('POST /api/organizations/:id/llm/validate', () => {
        it('éxito: 200 con validatedAt', async () => {
            vi.spyOn(llmConfigService, 'validateLlmCredentials').mockResolvedValue({
                success: true,
                validatedAt: '2026-08-17T00:00:00.000Z',
            });

            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/llm/validate`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });

            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ success: true, data: { validatedAt: '2026-08-17T00:00:00.000Z' } });
        });

        it('llave inválida: 422 con kind y mensaje accionable', async () => {
            vi.spyOn(llmConfigService, 'validateLlmCredentials').mockResolvedValue({
                success: false,
                kind: 'invalid_key',
                error: 'La llave no es válida. Verifica que la copiaste completa desde el panel del proveedor.',
            });

            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/llm/validate`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });

            expect(res.statusCode).toBe(422);
            expect(res.json()).toMatchObject({ success: false, kind: 'invalid_key' });
        });

        it('un no-miembro recibe 403', async () => {
            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/llm/validate`,
                headers: { authorization: `Bearer ${outsider.jwt}` },
            });
            expect(res.statusCode).toBe(403);
        });
    });
});
