import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import adminPlansRoutes from '../src/routes/admin/plans.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { ElevenLabsAdapter } from '../src/services/providers/ElevenLabsAdapter.js';

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
        it('contraparte de éxito: devuelve el catálogo completo, incluye isActive/sortOrder y la lista de features', async () => {
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
                expect(Array.isArray(starter.features)).toBe(true);
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

        it('rechaza con 400 si se envía una característica inexistente en features', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: `/api/admin/plans/${TEST_PLAN_KEY}`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { features: ['feature_inventada_inexistente'] },
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: actualiza la lista de características en plan_features', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'PATCH',
                    url: `/api/admin/plans/${TEST_PLAN_KEY}`,
                    headers: { 'x-platform-admin': 'true' },
                    payload: { features: ['voice_inbound', 'calendar_booking'] },
                });
                expect(response.statusCode).toBe(200);

                const getRes = await app.inject({
                    method: 'GET',
                    url: '/api/admin/plans',
                    headers: { 'x-platform-admin': 'true' },
                });
                const starter = getRes.json().data.find((p: any) => p.key === TEST_PLAN_KEY);
                expect(starter.features).toEqual(expect.arrayContaining(['voice_inbound', 'calendar_booking']));
            } finally {
                await app.close();
            }
        });
    });

    describe('GET /api/admin/plans/prompt-preview', () => {
        it('devuelve la vista previa del bloque PLANES: con éxito', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: '/api/admin/plans/prompt-preview',
                    headers: { 'x-platform-admin': 'true' },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.success).toBe(true);
                expect(typeof body.data.plansBlock).toBe('string');
                expect(body.data.plansBlock).toContain('PLANES:');
                expect(body.data.plansCount).toBeGreaterThan(0);
                expect(Array.isArray(body.data.plans)).toBe(true);
            } finally {
                await app.close();
            }
        });
    });

    describe('POST /api/admin/plans/sync-prompt', () => {
        let testOrgId: string;

        beforeAll(async () => {
            const { data: org, error } = await supabaseAdmin
                .from('organizations')
                .insert({
                    name: 'Org Test Sync Prompt',
                    email: `org-test-sync-${Date.now()}@example.invalid`,
                    status: 'active',
                    elevenlabs_agent_id: 'agent-mock-sync-123',
                })
                .select('id')
                .single();
            if (error || !org) throw new Error(`No se pudo crear org de prueba: ${error?.message}`);
            testOrgId = org.id;
        });

        afterAll(async () => {
            if (testOrgId) {
                await supabaseAdmin.from('organizations').delete().eq('id', testOrgId);
            }
        });

        it('sincroniza el system prompt con ElevenLabs mockeado', async () => {
            const getSpy = vi.spyOn(ElevenLabsAdapter.prototype, 'getAgentConfig').mockResolvedValueOnce({
                agentId: 'agent-mock-sync-123',
                firstMessage: 'Hola',
                systemPrompt: 'Eres un agente de Datagol.\n\nPLANES:\nViejo plan.\n\nREGLAS:\nSé amable.',
                voiceId: 'voice-123',
            });

            const syncSpy = vi.spyOn(ElevenLabsAdapter.prototype, 'syncAgentConfig').mockResolvedValueOnce(true);

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/admin/plans/sync-prompt',
                    headers: { 'x-platform-admin': 'true' },
                    payload: { organizationId: testOrgId },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.success).toBe(true);
                expect(body.data.agentId).toBe('agent-mock-sync-123');
                expect(body.data.updatedPromptSnippet).toContain('PLANES:');

                expect(getSpy).toHaveBeenCalledWith('agent-mock-sync-123', expect.any(String));
                expect(syncSpy).toHaveBeenCalled();
            } finally {
                await app.close();
                getSpy.mockRestore();
                syncSpy.mockRestore();
            }
        });
    });

    describe('GET/PATCH /api/admin/exchange-rate', () => {
        let testOrgId: string;
        const originalIntegrationSettings = { testKey: 'preserved_value' };

        beforeAll(async () => {
            const { data: org, error } = await supabaseAdmin
                .from('organizations')
                .insert({
                    name: 'Org Test Exchange Rate',
                    email: `org-test-rate-${Date.now()}@example.invalid`,
                    status: 'active',
                    integration_settings: originalIntegrationSettings,
                })
                .select('id')
                .single();
            if (error || !org) throw new Error(`No se pudo crear org de prueba: ${error?.message}`);
            testOrgId = org.id;
        });

        afterAll(async () => {
            if (testOrgId) {
                await supabaseAdmin.from('organizations').delete().eq('id', testOrgId);
            }
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
                    payload: { organizationId: testOrgId, tipoCambioUSD: 19.25 },
                });
                expect(patchResponse.statusCode).toBe(200);

                const getResponse = await app.inject({
                    method: 'GET',
                    url: `/api/admin/exchange-rate?organizationId=${testOrgId}`,
                    headers: { 'x-platform-admin': 'true' },
                });
                expect(getResponse.json().tipoCambioUSD).toBe(19.25);

                const { data: org } = await supabaseAdmin
                    .from('organizations')
                    .select('integration_settings')
                    .eq('id', testOrgId)
                    .single();
                for (const key of Object.keys(originalIntegrationSettings)) {
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
                    payload: { organizationId: testOrgId, tipoCambioUSD: 0 },
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });
    });
});
