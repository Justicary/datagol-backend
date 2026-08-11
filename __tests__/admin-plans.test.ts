import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import adminPlansRoutes from '../src/routes/admin/plans.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';
const TEST_PLAN_KEY = 'starter';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(adminPlansRoutes);
    await app.ready();
    return app;
}

describe('routes/admin/plans.ts', () => {
    describe('preHandler isPlatformAdmin (smoke test)', () => {
        it('rechaza sin autenticación de plataforma', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({ method: 'GET', url: '/api/admin/plans' });
                expect(response.statusCode).toBe(401);
            } finally {
                await app.close();
            }
        });
    });

    describe('GET /api/admin/plans', () => {
        it('contraparte de éxito: devuelve el catálogo completo, incluye isActive/sortOrder (no expuestos en el público)', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: '/api/admin/plans',
                    headers: { 'x-platform-admin': 'true' },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                const starter = body.data.find((p: any) => p.key === TEST_PLAN_KEY);
                expect(starter).toBeDefined();
                expect(typeof starter.isActive).toBe('boolean');
                expect(typeof starter.sortOrder).toBe('number');
            } finally {
                await app.close();
            }
        });
    });

    describe('PATCH /api/admin/plans/:key', () => {
        let originalPlan: Record<string, unknown>;

        beforeAll(async () => {
            const { data } = await supabaseAdmin.from('plans').select('*').eq('key', TEST_PLAN_KEY).single();
            originalPlan = data as Record<string, unknown>;
        });

        afterEach(async () => {
            await supabaseAdmin
                .from('plans')
                .update({
                    name: originalPlan.name,
                    setup_fee_mxn: originalPlan.setup_fee_mxn,
                    monthly_fee_mxn: originalPlan.monthly_fee_mxn,
                    max_concurrent_calls: originalPlan.max_concurrent_calls,
                    target_audience: originalPlan.target_audience,
                    badge: originalPlan.badge,
                    setup_includes: originalPlan.setup_includes,
                    retainer_includes: originalPlan.retainer_includes,
                    cta_text: originalPlan.cta_text,
                    is_popular: originalPlan.is_popular,
                    show_retainer: originalPlan.show_retainer,
                    is_active: originalPlan.is_active,
                })
                .eq('key', TEST_PLAN_KEY);
        });

        it('contraparte de éxito: actualiza precio, llamadas concurrentes y bullets, y se refleja al releer el plan', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: `/api/admin/plans/${TEST_PLAN_KEY}`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: {
                        setupFeeMxn: 5555,
                        maxConcurrentCalls: 15,
                        setupIncludes: ['Nuevo bullet de prueba'],
                    },
                });
                expect(response.statusCode).toBe(200);

                const { data: updated } = await supabaseAdmin.from('plans').select('*').eq('key', TEST_PLAN_KEY).single();
                expect(Number(updated?.setup_fee_mxn)).toBe(5555);
                expect(updated?.max_concurrent_calls).toBe(15);
                expect(updated?.setup_includes).toEqual(['Nuevo bullet de prueba']);
                // Campos no enviados no se tocan.
                expect(updated?.name).toBe(originalPlan.name);
            } finally {
                await app.close();
            }
        });

        it('acepta monthlyFeeMxn=null explícito ("Iguala A Medida") y badge=null explícito (sin badge)', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: `/api/admin/plans/${TEST_PLAN_KEY}`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { monthlyFeeMxn: null, badge: null },
                });
                expect(response.statusCode).toBe(200);

                const { data: updated } = await supabaseAdmin.from('plans').select('monthly_fee_mxn, badge').eq('key', TEST_PLAN_KEY).single();
                expect(updated?.monthly_fee_mxn).toBeNull();
                expect(updated?.badge).toBeNull();
            } finally {
                await app.close();
            }
        });

        it('400 con un precio negativo', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: `/api/admin/plans/${TEST_PLAN_KEY}`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { setupFeeMxn: -100 },
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('400 con setupIncludes que no es un arreglo de strings', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: `/api/admin/plans/${TEST_PLAN_KEY}`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { setupIncludes: 'no es un arreglo' },
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('400 con name vacío', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: `/api/admin/plans/${TEST_PLAN_KEY}`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { name: '   ' },
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('400 sin ningún campo en el body', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: `/api/admin/plans/${TEST_PLAN_KEY}`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: {},
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('404 para una clave de plan que no existe', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: '/api/admin/plans/plan-inexistente',
                    headers: { 'x-platform-admin': 'true' },
                    payload: { setupFeeMxn: 1 },
                });
                expect(response.statusCode).toBe(404);
            } finally {
                await app.close();
            }
        });
    });

    describe('GET/PATCH /api/admin/exchange-rate', () => {
        let originalIntegrationSettings: Record<string, unknown> | null;

        beforeAll(async () => {
            const { data: org } = await supabaseAdmin
                .from('organizations')
                .select('integration_settings')
                .eq('id', REAL_ORG_ID)
                .maybeSingle();
            originalIntegrationSettings = (org?.integration_settings as Record<string, unknown> | null) ?? null;
        });

        afterAll(async () => {
            await supabaseAdmin
                .from('organizations')
                .update({ integration_settings: originalIntegrationSettings })
                .eq('id', REAL_ORG_ID);
        });

        it('400 sin organizationId en GET', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: '/api/admin/exchange-rate',
                    headers: { 'x-platform-admin': 'true' },
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: PATCH guarda tipoCambioUSD y el siguiente GET lo devuelve, preservando otras claves de integration_settings', async () => {
            const app = await buildTestApp();
            try {
                const patchResponse = await app.inject({
                    method: 'PATCH',
                    url: '/api/admin/exchange-rate',
                    headers: { 'x-platform-admin': 'true' },
                    payload: { organizationId: REAL_ORG_ID, tipoCambioUSD: 19.25 },
                });
                expect(patchResponse.statusCode).toBe(200);

                const getResponse = await app.inject({
                    method: 'GET',
                    url: `/api/admin/exchange-rate?organizationId=${REAL_ORG_ID}`,
                    headers: { 'x-platform-admin': 'true' },
                });
                expect(getResponse.json().tipoCambioUSD).toBe(19.25);

                const { data: org } = await supabaseAdmin
                    .from('organizations')
                    .select('integration_settings')
                    .eq('id', REAL_ORG_ID)
                    .single();
                for (const key of Object.keys(originalIntegrationSettings ?? {})) {
                    if (key === 'tipoCambioUSD') continue;
                    expect((org?.integration_settings as Record<string, unknown>)[key]).toEqual(
                        (originalIntegrationSettings as Record<string, unknown>)[key]
                    );
                }
            } finally {
                await app.close();
            }
        });

        it('400 con tipoCambioUSD <= 0', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: '/api/admin/exchange-rate',
                    headers: { 'x-platform-admin': 'true' },
                    payload: { organizationId: REAL_ORG_ID, tipoCambioUSD: 0 },
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });
    });
});
