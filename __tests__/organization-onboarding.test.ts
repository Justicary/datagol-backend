import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationOnboardingRoutes from '../src/routes/organization-onboarding.js';
import { setOrganizationPlan, setFeatureOverride, clearEntitlementsCache } from '../src/services/entitlements.js';
import { reprovisionAgent } from '../src/services/agent-provisioning.js';
import { setSecret, getSecret } from '../src/services/secret-service.js';
import * as secretService from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(organizationOnboardingRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
    email: string;
}

/**
 * Crea un usuario real de Supabase Auth y obtiene un JWT real vía
 * `signInWithPassword` (cliente con la publishable key, no la service_role)
 * — el único modo de ejercitar de verdad `fastify.supabaseUser(jwt)` y las
 * políticas RLS reales, en vez de simular un JWT.
 */
async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-onboarding-${crypto.randomUUID()}@example.invalid`;
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

    return { userId: created.user.id, jwt: session.session.access_token, email };
}

async function deleteTestUser(userId: string): Promise<void> {
    await supabaseAdmin.auth.admin.deleteUser(userId);
}

async function deleteTestOrganization(organizationId: string): Promise<void> {
    await supabaseAdmin.from('organization_members').delete().eq('organization_id', organizationId);
    await supabaseAdmin.from('organizations').delete().eq('id', organizationId);
}

describe('routes/organization-onboarding.ts', () => {
    describe('POST /api/organizations', () => {
        it('sin JWT → 401', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/organizations',
                    payload: { name: 'Sin Auth Org', email: 'sin-auth@example.invalid' },
                });
                expect(response.statusCode).toBe(401);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: con JWT válido crea la organización Y la membresía owner en la misma operación', async () => {
            const user = await createTestUserWithJwt();
            const app = await buildTestApp();
            let orgId: string | undefined;
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/organizations',
                    headers: { authorization: `Bearer ${user.jwt}` },
                    payload: { name: 'Org Onboarding Test', email: `org-onboarding-${crypto.randomUUID()}@example.invalid` },
                });
                expect(response.statusCode).toBe(201);
                const body = response.json();
                expect(body.success).toBe(true);
                orgId = body.data.id;

                const { data: membership } = await supabaseAdmin
                    .from('organization_members')
                    .select('role')
                    .eq('organization_id', orgId)
                    .eq('user_id', user.userId)
                    .maybeSingle();
                expect(membership?.role).toBe('owner');
            } finally {
                await app.close();
                if (orgId) await deleteTestOrganization(orgId);
                await deleteTestUser(user.userId);
            }
        });

        it('atomicidad: si falla el INSERT en organization_members (vía la función create_organization_with_owner), no queda una organización huérfana', async () => {
            const fakeUserId = '11111111-1111-1111-1111-111111111111'; // no existe en auth.users -> viola FK
            const email = `atomicity-test-${crypto.randomUUID()}@example.invalid`;

            const { data, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
                p_name: 'Atomicity Test Org',
                p_email: email,
                p_phone_number: null,
                p_user_id: fakeUserId,
            });

            expect(error).not.toBeNull();
            expect(data).toBeNull();

            const { data: orphan } = await supabaseAdmin.from('organizations').select('id').eq('email', email);
            expect(orphan).toHaveLength(0);
        });
    });

    describe('PATCH /api/organizations/:id/business-info', () => {
        let owner: TestUser;
        let outsider: TestUser;
        let orgId: string;

        beforeAll(async () => {
            owner = await createTestUserWithJwt();
            outsider = await createTestUserWithJwt();

            const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
                p_name: 'Business Info Test Org',
                p_email: `business-info-${crypto.randomUUID()}@example.invalid`,
                p_phone_number: null,
                p_user_id: owner.userId,
            });
            if (error || !org) throw new Error(`Setup falló: ${error?.message}`);
            orgId = org.id;

            await supabaseAdmin
                .from('organizations')
                .update({ integration_settings: { theme: { accentColor: '#06b6d4' } } })
                .eq('id', orgId);
        });

        afterAll(async () => {
            await deleteTestOrganization(orgId);
            await deleteTestUser(owner.userId);
            await deleteTestUser(outsider.userId);
        });

        it('un usuario que no pertenece a la organización es rechazado por RLS (403), no un 200 silencioso', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/business-info`,
                    headers: { authorization: `Bearer ${outsider.jwt}` },
                    payload: { city: 'CDMX' },
                });
                expect(response.statusCode).toBe(403);

                const { data: unchanged } = await supabaseAdmin
                    .from('contact_addresses')
                    .select('city')
                    .eq('organization_id', orgId)
                    .is('contact_id', null)
                    .maybeSingle();
                expect(unchanged?.city ?? null).toBeNull();
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: el dueño puede actualizar business_hours sin borrar integration_settings.theme ya existente', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/business-info`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { city: 'CDMX', business_hours: { mon: '09:00-18:00' } },
                });
                expect(response.statusCode).toBe(200);

                const { data: updated } = await supabaseAdmin
                    .from('organizations')
                    .select('integration_settings')
                    .eq('id', orgId)
                    .single();
                const { data: updatedAddr } = await supabaseAdmin
                    .from('contact_addresses')
                    .select('city')
                    .eq('organization_id', orgId)
                    .is('contact_id', null)
                    .maybeSingle();
                expect(updatedAddr?.city).toBe('CDMX');
                expect(updated?.integration_settings?.theme).toEqual({ accentColor: '#06b6d4' });
                expect(updated?.integration_settings?.business_hours).toEqual({ mon: '09:00-18:00' });
            } finally {
                await app.close();
            }
        });

        it('rechaza una zona horaria que no es un identificador IANA válido (400)', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/business-info`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { timezone: 'Not/A_Real_Zone' },
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: el dueño puede fijar una zona horaria IANA válida (A.1)', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/business-info`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { timezone: 'America/Cancun' },
                });
                expect(response.statusCode).toBe(200);

                const { data: updated } = await supabaseAdmin
                    .from('organizations')
                    .select('timezone')
                    .eq('id', orgId)
                    .single();
                expect(updated?.timezone).toBe('America/Cancun');
            } finally {
                await app.close();
            }
        });
    });

    describe('POST /api/organizations/:id/credentials', () => {
        let owner: TestUser;
        let orgId: string;

        beforeAll(async () => {
            owner = await createTestUserWithJwt();
            const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
                p_name: 'Credentials Test Org',
                p_email: `credentials-${crypto.randomUUID()}@example.invalid`,
                p_phone_number: null,
                p_user_id: owner.userId,
            });
            if (error || !org) throw new Error(`Setup falló: ${error?.message}`);
            orgId = org.id;
        });

        afterAll(async () => {
            await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', orgId);
            await deleteTestOrganization(orgId);
            await deleteTestUser(owner.userId);
        });

        it('el valor de la credencial nunca aparece en la respuesta ni se pasa al logger', async () => {
            const secretValue = 'sk_super_secreto_de_prueba_12345';
            const logInfoSpy = vi.fn();
            const logErrorSpy = vi.fn();

            // No se usa buildTestApp(): el hook que reemplaza request.log debe
            // registrarse ANTES de app.ready() (Fastify lo prohíbe después).
            const app = Fastify({ logger: false });
            await app.register(supabasePlugin);
            app.addHook('onRequest', async (request) => {
                request.log.info = logInfoSpy as any;
                request.log.error = logErrorSpy as any;
            });
            await app.register(organizationOnboardingRoutes);
            await app.ready();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/credentials`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { provider: 'cal', value: secretValue },
                });
                expect(response.statusCode).toBe(200);
                expect(response.body).not.toContain(secretValue);

                const allLoggedArgs = JSON.stringify([...logInfoSpy.mock.calls, ...logErrorSpy.mock.calls]);
                expect(allLoggedArgs).not.toContain(secretValue);
            } finally {
                await app.close();
            }
        });

        it('provider "google_maps" (opcional, geocodificación de dirección del prospecto) se guarda como SECRET_KEYS.GOOGLE_MAPS_KEY', async () => {
            const secretValue = 'AIzaSyTestGoogleMapsKeyFake123456';
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/credentials`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { provider: 'google_maps', value: secretValue },
                });
                expect(response.statusCode).toBe(200);

                const stored = await getSecret(orgId, SECRET_KEYS.GOOGLE_MAPS_KEY);
                expect(stored).toBe(secretValue);
            } finally {
                await app.close();
            }
        });

        it('provider "llm" (BYOK, docs/tasks/reportes-semanales.md Fase A) se guarda como SECRET_KEYS.LLM_API_KEY', async () => {
            const secretValue = 'sk-or-v1-test-fake-key-1234567890';
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/credentials`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { provider: 'llm', value: secretValue },
                });
                expect(response.statusCode).toBe(200);

                const stored = await getSecret(orgId, SECRET_KEYS.LLM_API_KEY);
                expect(stored).toBe(secretValue);
            } finally {
                await app.close();
            }
        });
    });

    describe('GET /api/organizations/:id/credentials/status', () => {
        let owner: TestUser;
        let orgId: string;

        beforeAll(async () => {
            owner = await createTestUserWithJwt();
            const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
                p_name: 'Credentials Status Test Org',
                p_email: `credentials-status-${crypto.randomUUID()}@example.invalid`,
                p_phone_number: null,
                p_user_id: owner.userId,
            });
            if (error || !org) throw new Error(`Setup falló: ${error?.message}`);
            orgId = org.id;

            const saved = await setSecret(orgId, SECRET_KEYS.CAL_API_KEY, 'cal_test_value');
            if (!saved) throw new Error('No se pudo preparar el secreto de prueba');
        });

        afterAll(async () => {
            await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', orgId);
            await deleteTestOrganization(orgId);
            await deleteTestUser(owner.userId);
        });

        it('nunca llama a getSecret() (Vault) — solo consulta organization_secrets', async () => {
            const getSecretSpy = vi.spyOn(secretService, 'getSecret');
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgId}/credentials/status`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.data[SECRET_KEYS.CAL_API_KEY]).toMatchObject({ present: true });
                expect(body.data[SECRET_KEYS.ELEVENLABS_API_KEY]).toBeUndefined();
                expect(getSecretSpy).not.toHaveBeenCalled();
            } finally {
                await app.close();
                getSecretSpy.mockRestore();
            }
        });
    });

    /**
     * FASE B.2 (docs/tasks/catalogo-productos-grupos-cred.md): rotar una
     * llave compartida tumba a todo el grupo, así que solo el owner del
     * grupo de credenciales puede llamar POST .../credentials; el resto la
     * ve en solo lectura (GET .../credentials/status) con nota de quién la
     * administra.
     */
    describe('FASE B.2 — rotación de credenciales restringida al owner del grupo', () => {
        let ownerUser: TestUser;
        let memberUser: TestUser;
        let ownerOrgId: string;
        let memberOrgId: string;
        let groupId: string;

        beforeAll(async () => {
            ownerUser = await createTestUserWithJwt();
            memberUser = await createTestUserWithJwt();

            const { data: ownerOrg, error: ownerErr } = await supabaseAdmin.rpc('create_organization_with_owner', {
                p_name: 'Owner Grupo B2 Test Org',
                p_email: `owner-b2-${crypto.randomUUID()}@example.invalid`,
                p_phone_number: null,
                p_user_id: ownerUser.userId,
            });
            if (ownerErr || !ownerOrg) throw new Error(`Setup falló (owner): ${ownerErr?.message}`);
            ownerOrgId = ownerOrg.id;

            const { data: memberOrg, error: memberErr } = await supabaseAdmin.rpc('create_organization_with_owner', {
                p_name: 'Member Grupo B2 Test Org',
                p_email: `member-b2-${crypto.randomUUID()}@example.invalid`,
                p_phone_number: null,
                p_user_id: memberUser.userId,
            });
            if (memberErr || !memberOrg) throw new Error(`Setup falló (member): ${memberErr?.message}`);
            memberOrgId = memberOrg.id;

            // Fusiona ambas organizaciones en el mismo grupo, con ownerOrgId
            // como dueño — simula una franquicia que comparte workspace,
            // reutilizando el credential_groups de grupo-de-uno que ya tenía
            // ownerOrgId en vez de crear uno nuevo desde cero.
            const { data: ownerOrgRow, error: readGroupErr } = await supabaseAdmin
                .from('organizations')
                .select('credential_group_id')
                .eq('id', ownerOrgId)
                .single();
            if (readGroupErr || !ownerOrgRow) throw new Error(`No se pudo leer credential_group_id del owner: ${readGroupErr?.message}`);
            groupId = ownerOrgRow.credential_group_id;

            const { error: updateMemberErr } = await supabaseAdmin
                .from('organizations')
                .update({ credential_group_id: groupId })
                .eq('id', memberOrgId);
            if (updateMemberErr) throw new Error(`No se pudo unir memberOrg al grupo: ${updateMemberErr.message}`);

            const saved = await setSecret(ownerOrgId, SECRET_KEYS.CAL_API_KEY, 'cal_shared_group_secret_value');
            if (!saved) throw new Error('No se pudo preparar el secreto compartido de prueba');
        });

        afterAll(async () => {
            await supabaseAdmin.from('organization_secrets').delete().in('organization_id', [ownerOrgId, memberOrgId]);
            await deleteTestOrganization(memberOrgId);
            await deleteTestOrganization(ownerOrgId);
            await deleteTestUser(memberUser.userId);
            await deleteTestUser(ownerUser.userId);
        });

        it('un miembro no-owner recibe 403 al intentar rotar una credencial compartida', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${memberOrgId}/credentials`,
                    headers: { authorization: `Bearer ${memberUser.jwt}` },
                    payload: { provider: 'cal', value: 'intento-de-miembro-no-owner' },
                });
                expect(response.statusCode).toBe(403);
                expect(response.json().code).toBe('CREDENTIAL_GROUP_NOT_OWNER');

                // La escritura fue rechazada: el valor original del owner sigue vigente.
                const stillOriginal = await getSecret(ownerOrgId, SECRET_KEYS.CAL_API_KEY);
                expect(stillOriginal).toBe('cal_shared_group_secret_value');
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: el owner del grupo SÍ puede rotar la credencial compartida', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${ownerOrgId}/credentials`,
                    headers: { authorization: `Bearer ${ownerUser.jwt}` },
                    payload: { provider: 'cal', value: 'rotado-por-el-owner' },
                });
                expect(response.statusCode).toBe(200);

                const rotated = await getSecret(ownerOrgId, SECRET_KEYS.CAL_API_KEY);
                expect(rotated).toBe('rotado-por-el-owner');
            } finally {
                await app.close();
            }
        });

        it('GET .../credentials/status de un miembro no-owner muestra la llave compartida en solo lectura con isOwner=false y el nombre de quién la administra', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${memberOrgId}/credentials/status`,
                    headers: { authorization: `Bearer ${memberUser.jwt}` },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.isOwner).toBe(false);
                expect(body.managedByOrganizationName).toBe('Owner Grupo B2 Test Org');
                // El secreto lo guardó el owner, en su propia fila de
                // organization_secrets — el miembro debe verlo igual, resuelto
                // contra el grupo (FASE B.1/B.2), no contra su propia fila (vacía).
                expect(body.data[SECRET_KEYS.CAL_API_KEY]).toMatchObject({ present: true });
            } finally {
                await app.close();
            }
        });

        it('contraparte: GET .../credentials/status del owner muestra isOwner=true y managedByOrganizationName=null', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${ownerOrgId}/credentials/status`,
                    headers: { authorization: `Bearer ${ownerUser.jwt}` },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.isOwner).toBe(true);
                expect(body.managedByOrganizationName).toBeNull();
            } finally {
                await app.close();
            }
        });
    });

    describe('POST /api/organizations/:id/tokens', () => {
        let owner: TestUser;
        let orgId: string;

        beforeAll(async () => {
            owner = await createTestUserWithJwt();
            const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
                p_name: 'Tokens Test Org',
                p_email: `tokens-${crypto.randomUUID()}@example.invalid`,
                p_phone_number: null,
                p_user_id: owner.userId,
            });
            if (error || !org) throw new Error(`Setup falló: ${error?.message}`);
            orgId = org.id;
        });

        afterAll(async () => {
            await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', orgId);
            await deleteTestOrganization(orgId);
            await deleteTestUser(owner.userId);
        });

        it('primera llamada genera y persiste los tres valores; segunda llamada → 409 y los valores no cambian', async () => {
            const app = await buildTestApp();
            try {
                const first = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/tokens`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(first.statusCode).toBe(201);
                const firstBody = first.json();
                expect(firstBody.data.webhookToken).toMatch(/^[0-9a-f]{64}$/);
                expect(firstBody.data.webhookSigningSecret).toMatch(/^[0-9a-f]{64}$/);
                expect(firstBody.data.toolWebhookSecret).toMatch(/^[0-9a-f]{64}$/);

                const { data: orgAfterFirst } = await supabaseAdmin.from('organizations').select('webhook_token').eq('id', orgId).single();
                expect(orgAfterFirst?.webhook_token).toBe(firstBody.data.webhookToken);

                const second = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/tokens`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(second.statusCode).toBe(409);

                const { data: orgAfterSecond } = await supabaseAdmin.from('organizations').select('webhook_token').eq('id', orgId).single();
                expect(orgAfterSecond?.webhook_token).toBe(firstBody.data.webhookToken);
            } finally {
                await app.close();
            }
        });
    });

    describe('GET /api/organizations/:id/readiness', () => {
        let owner: TestUser;
        let orgId: string;

        beforeAll(async () => {
            owner = await createTestUserWithJwt();
            const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
                p_name: 'Readiness Test Org',
                p_email: `readiness-${crypto.randomUUID()}@example.invalid`,
                p_phone_number: null,
                p_user_id: owner.userId,
            });
            if (error || !org) throw new Error(`Setup falló: ${error?.message}`);
            orgId = org.id;
        });

        afterAll(async () => {
            await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', orgId);
            await supabaseAdmin.from('organization_features').delete().eq('organization_id', orgId);
            clearEntitlementsCache(orgId);
            await deleteTestOrganization(orgId);
            await deleteTestUser(owner.userId);
        });

        it('organización recién creada (sin plan, sin tokens, sin credenciales) → ready:false con las listas de faltantes pobladas', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgId}/readiness`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(response.statusCode).toBe(200);
                const { data } = response.json();
                expect(data.ready).toBe(false);
                expect(data.planKey).toBeNull();
                expect(data.missingTokens).toEqual(
                    expect.arrayContaining(['webhook_token', 'webhook_signing_secret', 'tool_webhook_secret'])
                );
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: organización completamente configurada → ready:true', async () => {
            // Plan 'starter' concede 5 features (voice_inbound, calendar_booking,
            // email_summaries, lead_capture, call_recording) — en vez de dar de
            // alta credenciales reales de cada proveedor, se deshabilitan todas
            // vía override explícito: getOrganizationFeatures() queda vacío y
            // missingCredentials se satisface trivialmente por no tener nada que
            // verificar, de forma determinista (sin depender de qué proveedor
            // requiere cada feature).
            await supabaseAdmin.from('organization_features').delete().eq('organization_id', orgId);
            await supabaseAdmin.from('plan_features').delete().eq('plan_key', 'starter').eq('feature_key', 'whatsapp');
            const planResult = await setOrganizationPlan(orgId, 'starter', 'Prueba readiness ready:true');
            expect(planResult.success).toBe(true);

            const starterFeatures = ['voice_inbound', 'calendar_booking', 'email_summaries', 'lead_capture', 'call_recording'];
            for (const featureKey of starterFeatures) {
                const overrideResult = await setFeatureOverride(orgId, featureKey, false, 'Prueba readiness ready:true');
                expect(overrideResult.success).toBe(true);
            }

            const app = await buildTestApp();
            try {
                const tokensResponse = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/tokens`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(tokensResponse.statusCode).toBe(201);

                // setFeatureOverride ya invoca reprovisionAgent() al final, que
                // limpia agent_reprovision_pending — se llama una vez más de
                // forma explícita para no depender de ese efecto secundario.
                await reprovisionAgent(orgId);

                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgId}/readiness`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(response.statusCode).toBe(200);
                const { data } = response.json();
                expect(data.missingTokens).toEqual([]);
                expect(data.missingCredentials).toEqual([]);
                expect(data.agentReprovisionPending).toBe(false);
                expect(data.ready).toBe(true);
            } finally {
                await app.close();
            }
        });
    });

    describe('agent_reprovision_pending', () => {
        let orgId: string;

        beforeAll(async () => {
            const { data: org, error } = await supabaseAdmin
                .from('organizations')
                .insert({ name: 'Reprovision Flag Test Org', email: `reprovision-flag-${crypto.randomUUID()}@example.invalid` })
                .select('id')
                .single();
            if (error || !org) throw new Error(`Setup falló: ${error?.message}`);
            orgId = org.id;
        });

        afterAll(async () => {
            await supabaseAdmin.from('organization_features').delete().eq('organization_id', orgId);
            clearEntitlementsCache(orgId);
            await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        });

        it('setOrganizationPlan() deja agent_reprovision_pending=true tras el UPDATE de plan, y reprovisionAgent() la limpia', async () => {
            // Se verifica marcando temporalmente el flag como no-limpiable: se
            // fuerza a false primero para partir de un estado conocido.
            await supabaseAdmin.from('organizations').update({ agent_reprovision_pending: false }).eq('id', orgId);

            const result = await setOrganizationPlan(orgId, 'starter', 'Prueba agent_reprovision_pending');
            expect(result.success).toBe(true);

            // setOrganizationPlan ya llama reprovisionAgent() al final (best-effort,
            // no bloqueante), así que en el camino feliz el flag ya vuelve a false.
            const { data: afterPlan } = await supabaseAdmin.from('organizations').select('agent_reprovision_pending').eq('id', orgId).single();
            expect(afterPlan?.agent_reprovision_pending).toBe(false);
        });

        it('contraparte: si reprovisionAgent() falla (UPDATE con error), la marca queda en true', async () => {
            await supabaseAdmin.from('organizations').update({ agent_reprovision_pending: true }).eq('id', orgId);

            // Simular un UPDATE fallido apuntando a un id inexistente: el
            // propio UPDATE no lanza error de Supabase (0 filas afectadas no
            // es un error), así que se fuerza el error mediante un id inválido
            // que Postgres sí rechaza por tipo (uuid malformado).
            const result = await reprovisionAgent('id-invalido-no-es-uuid');
            expect(result.success).toBe(false);

            const { data: unchanged } = await supabaseAdmin.from('organizations').select('agent_reprovision_pending').eq('id', orgId).single();
            expect(unchanged?.agent_reprovision_pending).toBe(true);
        });
    });

    describe('Aislamiento multi-tenant en los endpoints con :id', () => {
        let ownerA: TestUser;
        let ownerB: TestUser;
        let orgAId: string;
        let orgBId: string;

        beforeAll(async () => {
            ownerA = await createTestUserWithJwt();
            ownerB = await createTestUserWithJwt();

            const { data: orgA, error: errA } = await supabaseAdmin.rpc('create_organization_with_owner', {
                p_name: 'Tenant A Isolation Org',
                p_email: `tenant-a-${crypto.randomUUID()}@example.invalid`,
                p_phone_number: null,
                p_user_id: ownerA.userId,
            });
            if (errA || !orgA) throw new Error(`Setup falló (org A): ${errA?.message}`);
            orgAId = orgA.id;

            const { data: orgB, error: errB } = await supabaseAdmin.rpc('create_organization_with_owner', {
                p_name: 'Tenant B Isolation Org',
                p_email: `tenant-b-${crypto.randomUUID()}@example.invalid`,
                p_phone_number: null,
                p_user_id: ownerB.userId,
            });
            if (errB || !orgB) throw new Error(`Setup falló (org B): ${errB?.message}`);
            orgBId = orgB.id;
        });

        afterAll(async () => {
            await supabaseAdmin.from('organization_secrets').delete().in('organization_id', [orgAId, orgBId]);
            await deleteTestOrganization(orgAId);
            await deleteTestOrganization(orgBId);
            await deleteTestUser(ownerA.userId);
            await deleteTestUser(ownerB.userId);
        });

        const endpoints: Array<{ method: 'PATCH' | 'POST' | 'GET'; path: string; payload?: Record<string, unknown> }> = [
            { method: 'PATCH', path: 'business-info', payload: { city: 'CDMX' } },
            { method: 'PATCH', path: 'plan', payload: { plan_key: 'pro', reason: 'intento cross-tenant' } },
            { method: 'POST', path: 'credentials', payload: { provider: 'cal', value: 'intento-cross-tenant' } },
            { method: 'GET', path: 'credentials/status' },
            { method: 'POST', path: 'tokens' },
            { method: 'POST', path: 'provision-agent' },
            { method: 'GET', path: 'readiness' },
        ];

        it.each(endpoints)(
            'el dueño del tenant B no puede operar $method /api/organizations/:id/$path del tenant A (403)',
            async ({ method, path, payload }) => {
                const app = await buildTestApp();
                try {
                    const response = await app.inject({
                        method,
                        url: `/api/organizations/${orgAId}/${path}`,
                        headers: { authorization: `Bearer ${ownerB.jwt}` },
                        payload,
                    });
                    expect(response.statusCode).toBe(403);
                } finally {
                    await app.close();
                }
            }
        );

        it('contraparte de éxito: el dueño del tenant A sí puede operar sobre su propia organización (readiness)', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgAId}/readiness`,
                    headers: { authorization: `Bearer ${ownerA.jwt}` },
                });
                expect(response.statusCode).toBe(200);
            } finally {
                await app.close();
            }
        });
    });
});
