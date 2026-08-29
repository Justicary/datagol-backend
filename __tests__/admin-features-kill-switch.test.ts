import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import adminFeaturesRoutes from '../src/routes/admin/features.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { getOrganizationFeatures, clearEntitlementsCache } from '../src/services/entitlements.js';

const PLAN_FEATURE = 'calendar_booking';
// Feature que NO viene del plan starter — se concede exclusivamente por override.
const OVERRIDE_FEATURE = 'sms_agent';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(adminFeaturesRoutes);
    await app.ready();
    return app;
}

async function restoreKillSwitch(featureKey: string, originalValue: boolean) {
    await supabaseAdmin.from('features').update({ globally_disabled: originalValue, disabled_reason: null }).eq('key', featureKey);
    clearEntitlementsCache();
}

describe('POST /api/admin/features/:featureKey/kill-switch', () => {
    let planOrgId: string;
    let overrideOrgId: string;
    let originalGlobalValue: boolean;

    beforeAll(async () => {
        const { data: feature } = await supabaseAdmin.from('features').select('globally_disabled').eq('key', PLAN_FEATURE).maybeSingle();
        originalGlobalValue = feature?.globally_disabled ?? false;

        const { data: pOrg, error: pError } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org Plan kill-switch test', email: `test-plan-kill-switch-${Date.now()}@example.invalid`, plan_key: 'starter', status: 'active' })
            .select('id')
            .single();
        if (pError || !pOrg) throw new Error(`No se pudo crear la organización de plan: ${pError?.message}`);
        planOrgId = pOrg.id as string;

        const { data: org, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org Pruebas kill-switch', email: `test-kill-switch-${Date.now()}@example.invalid`, status: 'active' })
            .select('id')
            .single();
        if (error || !org) throw new Error(`No se pudo crear la organización de override: ${error?.message}`);
        overrideOrgId = org.id as string;

        await supabaseAdmin.from('organization_features').upsert(
            {
                organization_id: overrideOrgId,
                feature_key: OVERRIDE_FEATURE,
                enabled: true,
                reason: 'Setup de prueba kill-switch',
            },
            { onConflict: 'organization_id,feature_key' }
        );
    });

    afterAll(async () => {
        await restoreKillSwitch(PLAN_FEATURE, originalGlobalValue);
        await restoreKillSwitch(OVERRIDE_FEATURE, false);
        if (overrideOrgId) {
            await supabaseAdmin.from('feature_audit_log').delete().eq('organization_id', overrideOrgId);
            await supabaseAdmin.from('organization_features').delete().eq('organization_id', overrideOrgId);
            await supabaseAdmin.from('organizations').delete().eq('id', overrideOrgId);
        }
        if (planOrgId) {
            await supabaseAdmin.from('feature_audit_log').delete().eq('organization_id', planOrgId);
            await supabaseAdmin.from('organization_features').delete().eq('organization_id', planOrgId);
            await supabaseAdmin.from('organizations').delete().eq('id', planOrgId);
        }
        clearEntitlementsCache();
    });

    afterEach(async () => {
        clearEntitlementsCache();
    });

    it('rechaza sin autenticación de plataforma', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/api/admin/features/${PLAN_FEATURE}/kill-switch`,
                payload: { globally_disabled: true, reason: 'Prueba sin auth' },
            });
            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('400 cuando falta reason', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/api/admin/features/${PLAN_FEATURE}/kill-switch`,
                headers: { 'x-platform-admin': 'true' },
                payload: { globally_disabled: true },
            });
            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('404 cuando featureKey no existe', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/api/admin/features/feature_inexistente_xyz/kill-switch`,
                headers: { 'x-platform-admin': 'true' },
                payload: { globally_disabled: true, reason: 'Prueba de feature inexistente' },
            });
            expect(response.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it('togglear globally_disabled:true apaga la feature para una organización que la tiene por plan y otra que la tiene por override', async () => {
        const app = await buildTestApp();
        try {
            clearEntitlementsCache();
            const beforePlan = await getOrganizationFeatures(planOrgId);
            const beforeOverride = await getOrganizationFeatures(overrideOrgId);
            expect(beforePlan.has(PLAN_FEATURE)).toBe(true);
            expect(beforeOverride.has(OVERRIDE_FEATURE)).toBe(true);

            const responsePlan = await app.inject({
                method: 'POST',
                url: `/api/admin/features/${PLAN_FEATURE}/kill-switch`,
                headers: { 'x-platform-admin': 'true' },
                payload: { globally_disabled: true, reason: 'Prueba de kill switch — apagar feature de plan' },
            });
            expect(responsePlan.statusCode).toBe(200);

            const responseOverride = await app.inject({
                method: 'POST',
                url: `/api/admin/features/${OVERRIDE_FEATURE}/kill-switch`,
                headers: { 'x-platform-admin': 'true' },
                payload: { globally_disabled: true, reason: 'Prueba de kill switch — apagar feature de override' },
            });
            expect(responseOverride.statusCode).toBe(200);

            const afterPlan = await getOrganizationFeatures(planOrgId);
            const afterOverride = await getOrganizationFeatures(overrideOrgId);
            expect(afterPlan.has(PLAN_FEATURE)).toBe(false);
            expect(afterOverride.has(OVERRIDE_FEATURE)).toBe(false);

            const { data: featureRows } = await supabaseAdmin
                .from('features')
                .select('key, globally_disabled, disabled_reason')
                .in('key', [PLAN_FEATURE, OVERRIDE_FEATURE]);
            for (const row of featureRows || []) {
                expect(row.globally_disabled).toBe(true);
                expect(row.disabled_reason).not.toBeNull();
            }
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: togglear globally_disabled:false restaura la feature según su origen original (plan y override)', async () => {
        const app = await buildTestApp();
        try {
            // Dejar ambas features apagadas primero.
            await supabaseAdmin.from('features').update({ globally_disabled: true, disabled_reason: 'Setup previo' }).in('key', [PLAN_FEATURE, OVERRIDE_FEATURE]);
            clearEntitlementsCache();

            const responsePlan = await app.inject({
                method: 'POST',
                url: `/api/admin/features/${PLAN_FEATURE}/kill-switch`,
                headers: { 'x-platform-admin': 'true' },
                payload: { globally_disabled: false, reason: 'Prueba de reactivación de kill switch' },
            });
            expect(responsePlan.statusCode).toBe(200);

            const responseOverride = await app.inject({
                method: 'POST',
                url: `/api/admin/features/${OVERRIDE_FEATURE}/kill-switch`,
                headers: { 'x-platform-admin': 'true' },
                payload: { globally_disabled: false, reason: 'Prueba de reactivación de kill switch' },
            });
            expect(responseOverride.statusCode).toBe(200);

            const afterPlan = await getOrganizationFeatures(planOrgId);
            const afterOverride = await getOrganizationFeatures(overrideOrgId);
            expect(afterPlan.has(PLAN_FEATURE)).toBe(true);
            expect(afterOverride.has(OVERRIDE_FEATURE)).toBe(true);

            const { data: featureRows } = await supabaseAdmin
                .from('features')
                .select('key, globally_disabled, disabled_reason')
                .in('key', [PLAN_FEATURE, OVERRIDE_FEATURE]);
            for (const row of featureRows || []) {
                expect(row.globally_disabled).toBe(false);
                expect(row.disabled_reason).toBeNull();
            }
        } finally {
            await app.close();
        }
    });

    describe('GET /api/admin/features', () => {
        it('retorna el catálogo completo de características ordenado por sort_order', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: '/api/admin/features',
                    headers: { 'x-platform-admin': 'true' },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(Array.isArray(body.data)).toBe(true);
                expect(body.data.length).toBeGreaterThan(0);
                const first = body.data[0];
                expect(first).toHaveProperty('key');
                expect(first).toHaveProperty('name');
                expect(first).toHaveProperty('sort_order');
            } finally {
                await app.close();
            }
        });
    });
});
