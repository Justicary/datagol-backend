import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import adminOrganizationsRoutes from '../src/routes/admin/organizations.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { clearEntitlementsCache } from '../src/services/entitlements.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(adminOrganizationsRoutes);
    await app.ready();
    return app;
}

async function resetOrgStatus() {
    await supabaseAdmin
        .from('organizations')
        .update({ status: 'active', suspended_reason: null, suspended_at: null })
        .eq('id', REAL_ORG_ID);
    clearEntitlementsCache();
}

describe('routes/admin/organizations.ts', () => {
    afterEach(async () => {
        await resetOrgStatus();
    });

    describe('preHandler isPlatformAdmin (smoke test — cobertura completa en otro archivo)', () => {
        it('rechaza sin autenticación de plataforma', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({ method: 'GET', url: '/api/admin/organizations' });
                expect(response.statusCode).toBe(401);
            } finally {
                await app.close();
            }
        });
    });

    describe('GET /api/admin/organizations', () => {
        it('contraparte de éxito: devuelve el listado, nunca incluye webhook_token crudo', async () => {
            const { data: before } = await supabaseAdmin.from('organizations').select('webhook_token').eq('id', REAL_ORG_ID).maybeSingle();
            const originalWebhookToken: string | null = before?.webhook_token ?? null;
            await supabaseAdmin.from('organizations').update({ webhook_token: `admin-list-test-${Date.now()}` }).eq('id', REAL_ORG_ID);

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: '/api/admin/organizations',
                    headers: { 'x-platform-admin': 'true' },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(Array.isArray(body.organizations)).toBe(true);

                const org = body.organizations.find((o: any) => o.id === REAL_ORG_ID);
                expect(org).toBeDefined();
                expect(org).not.toHaveProperty('webhook_token');
                expect(org.webhook_token_present).toBe(true);
                expect(JSON.stringify(body)).not.toContain('admin-list-test-');
            } finally {
                await supabaseAdmin.from('organizations').update({ webhook_token: originalWebhookToken }).eq('id', REAL_ORG_ID);
                await app.close();
            }
        });
    });

    describe('POST /api/admin/organizations/:orgId/suspend', () => {
        it('400 cuando falta reason', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/admin/organizations/${REAL_ORG_ID}/suspend`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: {},
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: suspende la organización y devuelve la forma esperada', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/admin/organizations/${REAL_ORG_ID}/suspend`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { reason: 'Adeudo de facturación' },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.organization.id).toBe(REAL_ORG_ID);
                expect(body.organization.status).toBe('suspended');
                expect(body.organization.suspended_reason).toBe('Adeudo de facturación');
                expect(body.organization.suspended_at).not.toBeNull();
            } finally {
                await app.close();
            }
        });

        it('409 cuando la organización ya está suspendida', async () => {
            const app = await buildTestApp();
            try {
                await app.inject({
                    method: 'POST',
                    url: `/api/admin/organizations/${REAL_ORG_ID}/suspend`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { reason: 'Primera suspensión' },
                });

                const response = await app.inject({
                    method: 'POST',
                    url: `/api/admin/organizations/${REAL_ORG_ID}/suspend`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { reason: 'Segundo intento' },
                });
                expect(response.statusCode).toBe(409);
            } finally {
                await app.close();
            }
        });
    });

    describe('POST /api/admin/organizations/:orgId/reactivate', () => {
        it('400 cuando falta reason', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/admin/organizations/${REAL_ORG_ID}/reactivate`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: {},
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('409 cuando la organización ya está activa', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/admin/organizations/${REAL_ORG_ID}/reactivate`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { reason: 'Ya está activa' },
                });
                expect(response.statusCode).toBe(409);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: reactiva una organización suspendida y devuelve la forma esperada', async () => {
            const app = await buildTestApp();
            try {
                await app.inject({
                    method: 'POST',
                    url: `/api/admin/organizations/${REAL_ORG_ID}/suspend`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { reason: 'Suspensión previa para prueba de reactivación' },
                });

                const response = await app.inject({
                    method: 'POST',
                    url: `/api/admin/organizations/${REAL_ORG_ID}/reactivate`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { reason: 'Pago regularizado' },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.organization.status).toBe('active');
                expect(body.organization.suspended_reason).toBeNull();
                expect(body.organization.suspended_at).toBeNull();
            } finally {
                await app.close();
            }
        });
    });
});
