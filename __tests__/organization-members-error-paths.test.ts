import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationMembersRoutes from '../src/routes/organization-members.js';
import * as invitationService from '../src/services/invitation-service.js';
import { ORGANIZATION_ROLES } from '../src/types/organization-roles.js';

const INVALID_UUID_MESSAGE = 'El parámetro de ruta "id" debe ser un UUID válido.';
const INVALID_UUID_PARAMS_MESSAGE = 'Los parámetros de ruta deben ser UUID válidos.';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(organizationMembersRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-members-err-${crypto.randomUUID()}@example.invalid`;
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

describe('routes/organization-members.ts — parámetros inválidos y ramas 500', () => {
    let app: FastifyInstance;
    let owner: TestUser;
    let orgId: string;

    beforeAll(async () => {
        app = await buildTestApp();
        owner = await createTestUserWithJwt();
        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Members Error Paths Test Org',
            p_email: `members-err-test-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`Setup falló creando organización: ${error?.message}`);
        orgId = org.id;
    });

    afterAll(async () => {
        await app.close();
        await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await deleteTestUser(owner.userId);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('POST /invitations con "id" que no es UUID → 400', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/organizations/no-es-un-uuid/invitations',
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: { email: 'x@example.invalid', role: 'member' },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ success: false, error: INVALID_UUID_MESSAGE });
    });

    it('GET /invitations con "id" que no es UUID → 400', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/organizations/no-es-un-uuid/invitations',
            headers: { authorization: `Bearer ${owner.jwt}` },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ success: false, error: INVALID_UUID_MESSAGE });
    });

    it('GET /invitations: si el servicio lanza, responde 500 (no 200 con datos parciales)', async () => {
        vi.spyOn(invitationService, 'listPendingInvitations').mockRejectedValue(new Error('Simulated failure'));
        const res = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/invitations`,
            headers: { authorization: `Bearer ${owner.jwt}` },
        });
        expect(res.statusCode).toBe(500);
        expect(res.json()).toEqual({ success: false, error: 'No se pudieron listar las invitaciones.' });
    });

    it('DELETE /invitations/:invId con parámetros que no son UUID → 400', async () => {
        const res = await app.inject({
            method: 'DELETE',
            url: `/api/organizations/${orgId}/invitations/no-es-un-uuid`,
            headers: { authorization: `Bearer ${owner.jwt}` },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ success: false, error: INVALID_UUID_PARAMS_MESSAGE });
    });

    it('POST /invitations/accept sin "token" en el body → 400', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/invitations/accept',
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: {},
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ success: false, error: 'Cuerpo de la petición inválido: se requiere "token".' });
    });

    it('POST /invitations/accept: si no se puede determinar el correo de la sesión, 400 (no revienta)', async () => {
        // fastify.supabaseAdmin (decorado por plugins/supabase.ts) es una
        // instancia DISTINTA del singleton lib/supabase.js — hay que
        // mockear la que la ruta realmente usa (app.supabaseAdmin).
        vi.spyOn(app.supabaseAdmin.auth.admin, 'getUserById').mockResolvedValue({
            data: { user: null },
            error: null,
        } as any);
        const res = await app.inject({
            method: 'POST',
            url: '/api/invitations/accept',
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: { token: 'algun-token' },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ success: false, error: 'No se pudo determinar el correo de la sesión actual.' });
    });

    it('POST /invitations/accept: si getUserById devuelve un error explícito (no solo user null), también 400', async () => {
        vi.spyOn(app.supabaseAdmin.auth.admin, 'getUserById').mockResolvedValue({
            data: { user: null },
            error: { message: 'Simulated auth error' },
        } as any);
        const res = await app.inject({
            method: 'POST',
            url: '/api/invitations/accept',
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: { token: 'algun-token' },
        });
        expect(res.statusCode).toBe(400);
    });

    it('GET /members con "id" que no es UUID → 400', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/organizations/no-es-un-uuid/members',
            headers: { authorization: `Bearer ${owner.jwt}` },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ success: false, error: INVALID_UUID_MESSAGE });
    });

    it('GET /members: si el servicio lanza, responde 500', async () => {
        vi.spyOn(invitationService, 'listOrganizationMembers').mockRejectedValue(new Error('Simulated failure'));
        const res = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/members`,
            headers: { authorization: `Bearer ${owner.jwt}` },
        });
        expect(res.statusCode).toBe(500);
        expect(res.json()).toEqual({ success: false, error: 'No se pudieron listar los miembros.' });
    });

    it('PATCH /members/:memberId con parámetros que no son UUID → 400', async () => {
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/organizations/${orgId}/members/no-es-un-uuid`,
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: { role: 'admin' },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ success: false, error: INVALID_UUID_PARAMS_MESSAGE });
    });

    it('PATCH /members/:memberId con "role" inválido (no es owner/admin/member/viewer) → 400', async () => {
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/organizations/${orgId}/members/${crypto.randomUUID()}`,
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: { role: 'super-admin-inventado' },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ success: false, error: 'Cuerpo de la petición inválido: se requiere "role" válido.' });
    });

    it('DELETE /members/:memberId con parámetros que no son UUID → 400', async () => {
        const res = await app.inject({
            method: 'DELETE',
            url: `/api/organizations/${orgId}/members/no-es-un-uuid`,
            headers: { authorization: `Bearer ${owner.jwt}` },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ success: false, error: INVALID_UUID_PARAMS_MESSAGE });
    });
});
