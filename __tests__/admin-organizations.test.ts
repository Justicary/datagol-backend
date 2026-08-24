import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import adminOrganizationsRoutes from '../src/routes/admin/organizations.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { clearEntitlementsCache } from '../src/services/entitlements.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(adminOrganizationsRoutes);
    await app.ready();
    return app;
}

describe('routes/admin/organizations.ts', () => {
    let orgId: string;

    beforeAll(async () => {
        const { data: org, error } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org (admin-organizations.test.ts)',
                email: `org-admin-test-${Date.now()}@example.invalid`,
                status: 'active',
                webhook_token: `admin-list-test-${Date.now()}`,
            })
            .select('id')
            .single();
        if (error || !org) throw new Error(`No se pudo crear org de prueba: ${error?.message}`);
        orgId = org.id;
    });

    afterAll(async () => {
        if (orgId) await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        clearEntitlementsCache();
    });

    afterEach(async () => {
        if (orgId) {
            await supabaseAdmin
                .from('organizations')
                .update({ status: 'active', suspended_reason: null, suspended_at: null })
                .eq('id', orgId);
        }
        clearEntitlementsCache();
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

                const org = body.organizations.find((o: any) => o.id === orgId);
                expect(org).toBeDefined();
                expect(org).not.toHaveProperty('webhook_token');
                expect(org.webhook_token_present).toBe(true);
                expect(JSON.stringify(body)).not.toContain('admin-list-test-');
            } finally {
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
                    url: `/api/admin/organizations/${orgId}/suspend`,
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
                    url: `/api/admin/organizations/${orgId}/suspend`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { reason: 'Adeudo de facturación' },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.organization.id).toBe(orgId);
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
                    url: `/api/admin/organizations/${orgId}/suspend`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { reason: 'Primera suspensión' },
                });

                const response = await app.inject({
                    method: 'POST',
                    url: `/api/admin/organizations/${orgId}/suspend`,
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
                    url: `/api/admin/organizations/${orgId}/reactivate`,
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
                    url: `/api/admin/organizations/${orgId}/reactivate`,
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
                    url: `/api/admin/organizations/${orgId}/suspend`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { reason: 'Suspensión previa para prueba de reactivación' },
                });

                const response = await app.inject({
                    method: 'POST',
                    url: `/api/admin/organizations/${orgId}/reactivate`,
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
