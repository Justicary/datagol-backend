import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import plansRoutes from '../src/routes/plans.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

const TEST_PLAN_KEY = `diag_inactive_${Date.now()}`;

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(plansRoutes);
    await app.ready();
    return app;
}

describe('GET /api/plans/public', () => {
    let orgId: string;

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

        const { data: org, error } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org (plans-public.test.ts)',
                email: `org-plans-pub-${Date.now()}@example.invalid`,
                status: 'active',
            })
            .select('id')
            .single();
        if (error || !org) throw new Error(`No se pudo crear org de prueba: ${error?.message}`);
        orgId = org.id;
    });

    afterAll(async () => {
        await supabaseAdmin.from('plans').delete().eq('key', TEST_PLAN_KEY);
        if (orgId) await supabaseAdmin.from('organizations').delete().eq('id', orgId);
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
            .update({ integration_settings: { tipoCambioUSD: 18.5 } })
            .eq('id', orgId);

        const app = await buildTestApp();
        try {
            const response = await app.inject({ method: 'GET', url: `/api/plans/public?organizationId=${orgId}` });
            expect(response.json().tipoCambioUsd).toBe(18.5);
        } finally {
            await app.close();
        }
    });
});
