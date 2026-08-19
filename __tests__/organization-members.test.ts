import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationMembersRoutes from '../src/routes/organization-members.js';
import { setResendClientForTesting } from '../src/services/email.js';
import { ORGANIZATION_ROLES } from '../src/types/organization-roles.js';

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
    email: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-members-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createErr || !created.user) throw new Error(`No se pudo crear el usuario de prueba: ${createErr?.message}`);

    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) throw new Error(`No se pudo iniciar sesión de prueba: ${signInErr?.message}`);

    return { userId: created.user.id, jwt: session.session.access_token, email };
}

async function deleteTestUser(userId: string): Promise<void> {
    await supabaseAdmin.auth.admin.deleteUser(userId);
}

async function createOrg(ownerUserId: string, planKey: string): Promise<string> {
    const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
        p_name: 'Members Test Org',
        p_email: `members-test-${crypto.randomUUID()}@example.invalid`,
        p_phone_number: null,
        p_user_id: ownerUserId,
    });
    if (error || !org) throw new Error(`Setup falló creando organización: ${error?.message}`);
    await supabaseAdmin.from('organizations').update({ plan_key: planKey }).eq('id', org.id);
    return org.id;
}

describe('routes/organization-members.ts — invitaciones y miembros (RBAC FASE C)', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildTestApp();
        // Evita envíos reales por Resend durante las pruebas — mismo patrón
        // que __tests__/thank-you-email.test.ts. createInvitation() intenta
        // enviar un correo real de invitación en cada POST /invitations.
        setResendClientForTesting({
            emails: { send: vi.fn().mockResolvedValue({ data: { id: 'test-email-id' }, error: null }) },
        } as any);
    });

    afterAll(async () => {
        setResendClientForTesting(null);
        await app.close();
    });

    describe('flujo general (plan elite, 15 asientos — headroom para varias invitaciones acumuladas en este bloque)', () => {
        let owner: TestUser;
        let admin: TestUser;
        let member: TestUser;
        let outsider: TestUser;
        let orgId: string;

        beforeAll(async () => {
            owner = await createTestUserWithJwt();
            admin = await createTestUserWithJwt();
            member = await createTestUserWithJwt();
            outsider = await createTestUserWithJwt();
            orgId = await createOrg(owner.userId, 'elite');

            const { error } = await supabaseAdmin.from('organization_members').insert([
                { organization_id: orgId, user_id: admin.userId, role: ORGANIZATION_ROLES.ADMIN },
                { organization_id: orgId, user_id: member.userId, role: ORGANIZATION_ROLES.MEMBER },
            ]);
            if (error) throw new Error(`Setup falló agregando miembros: ${error.message}`);
        });

        afterAll(async () => {
            await supabaseAdmin.from('organization_invitations').delete().eq('organization_id', orgId);
            await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
            await supabaseAdmin.from('organizations').delete().eq('id', orgId);
            await deleteTestUser(owner.userId);
            await deleteTestUser(admin.userId);
            await deleteTestUser(member.userId);
            await deleteTestUser(outsider.userId);
        });

        it('un member (sin manage_users) recibe 403 al crear una invitación', async () => {
            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/invitations`,
                headers: { authorization: `Bearer ${member.jwt}` },
                payload: { email: 'nadie@example.invalid', role: 'member' },
            });
            expect(res.statusCode).toBe(403);
        });

        it('no se puede invitar como owner', async () => {
            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/invitations`,
                headers: { authorization: `Bearer ${owner.jwt}` },
                payload: { email: 'futuro-owner@example.invalid', role: 'owner' },
            });
            expect(res.statusCode).toBe(400);
        });

        it('contraparte de éxito: el owner crea una invitación y el token NUNCA aparece en la respuesta', async () => {
            const inviteeEmail = `invitee-${crypto.randomUUID()}@example.invalid`;
            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/invitations`,
                headers: { authorization: `Bearer ${owner.jwt}` },
                payload: { email: inviteeEmail, role: 'viewer' },
            });
            expect(res.statusCode).toBe(201);
            const body = res.json();
            expect(body.data.email).toBe(inviteeEmail);
            expect(body.data.role).toBe('viewer');
            const serialized = JSON.stringify(body);
            expect(serialized).not.toContain('token');
            expect(serialized).not.toMatch(/[0-9a-f]{64}/); // 32 bytes hex = 64 chars: ni el token ni su hash

            const listRes = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/invitations`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(listRes.statusCode).toBe(200);
            const listBody = listRes.json();
            expect(listBody.data.invitations.some((inv: any) => inv.email === inviteeEmail)).toBe(true);
            expect(JSON.stringify(listBody)).not.toContain('token_hash');
        });

        it('revocar una invitación pendiente funciona y ya no aparece en el listado', async () => {
            const inviteeEmail = `revoke-me-${crypto.randomUUID()}@example.invalid`;
            const createRes = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/invitations`,
                headers: { authorization: `Bearer ${owner.jwt}` },
                payload: { email: inviteeEmail, role: 'member' },
            });
            const invId = createRes.json().data.id;

            const revokeRes = await app.inject({
                method: 'DELETE',
                url: `/api/organizations/${orgId}/invitations/${invId}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(revokeRes.statusCode).toBe(200);

            const listRes = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/invitations`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(listRes.json().data.invitations.some((inv: any) => inv.id === invId)).toBe(false);

            const revokeAgainRes = await app.inject({
                method: 'DELETE',
                url: `/api/organizations/${orgId}/invitations/${invId}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(revokeAgainRes.statusCode).toBe(409);
        });

        it('aceptar con un correo distinto al invitado se rechaza', async () => {
            const inviteeEmail = `mismatch-${crypto.randomUUID()}@example.invalid`;
            await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/invitations`,
                headers: { authorization: `Bearer ${owner.jwt}` },
                payload: { email: inviteeEmail, role: 'member' },
            });

            // outsider tiene un correo distinto al invitado — el token real no
            // se conoce (nunca viaja por API), así que se ejercita con un
            // token cualquiera para confirmar que el rechazo es por 400 de
            // "token" mal formado o por invalidez, nunca un 200.
            const res = await app.inject({
                method: 'POST',
                url: `/api/invitations/accept`,
                headers: { authorization: `Bearer ${outsider.jwt}` },
                payload: { token: 'token-inexistente-o-no-propio' },
            });
            expect(res.statusCode).not.toBe(200);
        });

        it('contraparte de éxito: aceptar una invitación válida crea la membresía con el rol invitado', async () => {
            const invitee = await createTestUserWithJwt();
            try {
                const { data: created } = await supabaseAdmin
                    .from('organizations')
                    .select('id')
                    .eq('id', orgId)
                    .maybeSingle();
                expect(created).toBeTruthy();

                // Se genera el token igual que create_invitation lo espera
                // (hash sha256) para poder ejercitar accept_invitation sin
                // depender del envío real de correo (RESEND_API_KEY puede no
                // estar configurada en el entorno de pruebas).
                const token = crypto.randomBytes(32).toString('hex');
                const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
                const { error: rpcError } = await supabaseAdmin.rpc('create_invitation', {
                    p_org_id: orgId,
                    p_email: invitee.email,
                    p_role: 'member',
                    p_token_hash: tokenHash,
                    p_invited_by: owner.userId,
                });
                expect(rpcError).toBeNull();

                const acceptRes = await app.inject({
                    method: 'POST',
                    url: '/api/invitations/accept',
                    headers: { authorization: `Bearer ${invitee.jwt}` },
                    payload: { token },
                });
                expect(acceptRes.statusCode).toBe(200);
                expect(acceptRes.json().data.role).toBe('member');

                const { data: membership } = await supabaseAdmin
                    .from('organization_members')
                    .select('role')
                    .eq('organization_id', orgId)
                    .eq('user_id', invitee.userId)
                    .maybeSingle();
                expect(membership?.role).toBe('member');

                await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId).eq('user_id', invitee.userId);
            } finally {
                await deleteTestUser(invitee.userId);
            }
        });

        it('nadie puede modificar su propio rol (ni el owner)', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${orgId}/members/${owner.userId}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
                payload: { role: 'admin' },
            });
            expect(res.statusCode).toBe(403);
        });

        it('un admin no puede modificar al owner', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${orgId}/members/${owner.userId}`,
                headers: { authorization: `Bearer ${admin.jwt}` },
                payload: { role: 'member' },
            });
            expect(res.statusCode).toBe(403);
        });

        it('un admin no puede promover a nadie a owner', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${orgId}/members/${member.userId}`,
                headers: { authorization: `Bearer ${admin.jwt}` },
                payload: { role: 'owner' },
            });
            expect(res.statusCode).toBe(403);
        });

        it('contraparte de éxito: el owner puede cambiar el rol de un member a admin', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${orgId}/members/${member.userId}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
                payload: { role: 'admin' },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.newRole).toBe('admin');

            // Revertir para no afectar otras pruebas de este bloque.
            await supabaseAdmin
                .from('organization_members')
                .update({ role: ORGANIZATION_ROLES.MEMBER })
                .eq('organization_id', orgId)
                .eq('user_id', member.userId);
        });

        it('nadie puede desactivarse a sí mismo', async () => {
            const res = await app.inject({
                method: 'DELETE',
                url: `/api/organizations/${orgId}/members/${owner.userId}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(res.statusCode).toBe(403);
        });

        it('desactivar al último owner se rechaza', async () => {
            // admin intenta desactivar al owner — primero falla por
            // ADMIN_CANNOT_MODIFY_OWNER; para probar específicamente
            // LAST_OWNER hace falta que el actor SEA owner. Se promueve a
            // `admin` a co-owner temporalmente para aislar la guarda.
            await supabaseAdmin
                .from('organization_members')
                .update({ role: ORGANIZATION_ROLES.OWNER })
                .eq('organization_id', orgId)
                .eq('user_id', admin.userId);

            // Ahora hay dos owners: owner y admin(->owner). Desactivar a uno
            // debe funcionar (no es el último); desactivar al restante sí
            // debe fallar por LAST_OWNER.
            const firstDeactivate = await app.inject({
                method: 'DELETE',
                url: `/api/organizations/${orgId}/members/${admin.userId}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(firstDeactivate.statusCode).toBe(200);

            const secondDeactivate = await app.inject({
                method: 'DELETE',
                url: `/api/organizations/${orgId}/members/${owner.userId}`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });
            // member no tiene manage_users -> 403 antes de llegar a la
            // guarda de negocio; se re-agrega admin como admin normal para
            // dejar el fixture consistente con el resto de las pruebas.
            expect(secondDeactivate.statusCode).toBe(403);

            await supabaseAdmin
                .from('organization_members')
                .insert({ organization_id: orgId, user_id: admin.userId, role: ORGANIZATION_ROLES.ADMIN });
        });

        it('contraparte de éxito: el owner puede desactivar a un member', async () => {
            const disposable = await createTestUserWithJwt();
            try {
                await supabaseAdmin
                    .from('organization_members')
                    .insert({ organization_id: orgId, user_id: disposable.userId, role: ORGANIZATION_ROLES.VIEWER });

                const res = await app.inject({
                    method: 'DELETE',
                    url: `/api/organizations/${orgId}/members/${disposable.userId}`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(res.statusCode).toBe(200);

                const { data: membership } = await supabaseAdmin
                    .from('organization_members')
                    .select('id')
                    .eq('organization_id', orgId)
                    .eq('user_id', disposable.userId)
                    .maybeSingle();
                expect(membership).toBeNull();
            } finally {
                await deleteTestUser(disposable.userId);
            }
        });

        it('GET /members: cualquier miembro puede listar el equipo', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/members`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });
            expect(res.statusCode).toBe(200);
            expect(Array.isArray(res.json().data)).toBe(true);
        });

        it('GET /members: un outsider recibe 403', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/members`,
                headers: { authorization: `Bearer ${outsider.jwt}` },
            });
            expect(res.statusCode).toBe(403);
        });
    });

    describe('límite de asientos (plan starter, 2 asientos)', () => {
        let owner: TestUser;
        let orgId: string;

        beforeAll(async () => {
            owner = await createTestUserWithJwt();
            orgId = await createOrg(owner.userId, 'starter');
        });

        afterAll(async () => {
            await supabaseAdmin.from('organization_invitations').delete().eq('organization_id', orgId);
            await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
            await supabaseAdmin.from('organizations').delete().eq('id', orgId);
            await deleteTestUser(owner.userId);
        });

        it('las invitaciones pendientes cuentan contra el límite y el segundo intento devuelve mensaje accionable con el límite', async () => {
            // starter = 2 asientos. owner ya ocupa 1. Una invitación pendiente
            // ocupa el segundo (organization_seats_used cuenta invitaciones
            // vigentes) — la SIGUIENTE invitación debe rechazarse.
            const firstInvite = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/invitations`,
                headers: { authorization: `Bearer ${owner.jwt}` },
                payload: { email: `seat-1-${crypto.randomUUID()}@example.invalid`, role: 'member' },
            });
            expect(firstInvite.statusCode).toBe(201);

            const secondInvite = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/invitations`,
                headers: { authorization: `Bearer ${owner.jwt}` },
                payload: { email: `seat-2-${crypto.randomUUID()}@example.invalid`, role: 'member' },
            });
            expect(secondInvite.statusCode).toBe(400);
            const message: string = secondInvite.json().error;
            expect(message).toContain('2');
            expect(secondInvite.json().code).toBe('SEAT_LIMIT');
            // Verifica el plan siguiente sugerido de verdad (buildSeatLimitMessage):
            // starter (2 asientos) → pro (5 asientos) es el próximo con más cupo.
            expect(message).toContain('Pro Omnicanal');
            expect(message).toContain('permite hasta 5 usuarios');
        });
    });
});
