import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import plansRoutes from '../src/routes/plans.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';
const TEST_PLAN_KEY = `diag_inactive_${Date.now()}`;

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(plansRoutes);
    await app.ready();
    return app;
}

describe('GET /api/plans/public', () => {
    let originalIntegrationSettings: Record<string, unknown> | null;

    beforeAll(async () => {
        await supabaseAdmin.from('plans').insert({
            key: TEST_PLAN_KEY,
            name: 'Plan Inactivo de Prueba',
            setup_fee_mxn: 1,
            monthly_fee_mxn: null,
            max_concurrent_calls: 1,
            is_active: false,
            sort_order: 999,
            target_audience: 'Prueba',
            cta_text: 'CTA de prueba',
        });

        const { data: org } = await supabaseAdmin
            .from('organizations')
            .select('integration_settings')
            .eq('id', REAL_ORG_ID)
            .maybeSingle();
        originalIntegrationSettings = (org?.integration_settings as Record<string, unknown> | null) ?? null;
    });

    afterAll(async () => {
        await supabaseAdmin.from('plans').delete().eq('key', TEST_PLAN_KEY);
        await supabaseAdmin
            .from('organizations')
            .update({ integration_settings: originalIntegrationSettings })
            .eq('id', REAL_ORG_ID);
    });

    it('contraparte de éxito: devuelve el catálogo activo con nombre, precios MXN, llamadas concurrentes y copy de marketing', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({ method: 'GET', url: '/api/plans/public' });
            expect(response.statusCode).toBe(200);

            const body = response.json();
            expect(body.success).toBe(true);
            expect(Array.isArray(body.data)).toBe(true);

            const starter = body.data.find((p: any) => p.key === 'starter');
            expect(starter).toBeDefined();
            expect(typeof starter.name).toBe('string');
            expect(typeof starter.setupFeeMxn).toBe('number');
            expect(typeof starter.maxConcurrentCalls).toBe('number');
            expect(typeof starter.targetAudience).toBe('string');
            expect(Array.isArray(starter.setupIncludes)).toBe(true);
            expect(Array.isArray(starter.retainerIncludes)).toBe(true);
            expect(typeof starter.ctaText).toBe('string');
            expect(typeof starter.showRetainer).toBe('boolean');
        } finally {
            await app.close();
        }
    });

    it('nunca incluye planes inactivos', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({ method: 'GET', url: '/api/plans/public' });
            const body = response.json();
            expect(body.data.some((p: any) => p.key === TEST_PLAN_KEY)).toBe(false);
        } finally {
            await app.close();
        }
    });

    it('sin organizationId, tipoCambioUsd es null (nunca inventa un tipo de cambio)', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({ method: 'GET', url: '/api/plans/public' });
            expect(response.json().tipoCambioUsd).toBeNull();
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: con organizationId y tipoCambioUSD configurado, lo devuelve', async () => {
        await supabaseAdmin
            .from('organizations')
            .update({ integration_settings: { ...(originalIntegrationSettings ?? {}), tipoCambioUSD: 18.5 } })
            .eq('id', REAL_ORG_ID);

        const app = await buildTestApp();
        try {
            const response = await app.inject({ method: 'GET', url: `/api/plans/public?organizationId=${REAL_ORG_ID}` });
            expect(response.json().tipoCambioUsd).toBe(18.5);
        } finally {
            await app.close();
        }
    });
});
