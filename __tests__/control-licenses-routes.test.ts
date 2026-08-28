import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { controlLicensesRoutes } from '../src/routes/control/licenses.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { createTestCustomer, createTestDeployment, cleanupDeployment, cleanupCustomer } from './helpers/control-plane-fixtures.js';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(controlLicensesRoutes);
    await app.ready();
    return app;
}

// `plan_features` es una tabla GLOBAL compartida con planes reales ('pro',
// 'starter', ...) que otras pruebas y organizaciones reales dependen. Se usa
// una clave de plan inventada y exclusiva de este archivo — nunca se toca
// 'pro' ni ningún otro plan real, así no hay riesgo de borrar una fila de
// configuración legítima que otra prueba (o un tenant real) necesite.
const FAKE_PLAN_KEY = `test-plan-licenses-${Date.now()}`;

describe('routes/control/licenses.ts (Fase A.3)', () => {
    let customerId: string;
    let deploymentId: string;

    beforeAll(async () => {
        const customer = await createTestCustomer();
        customerId = customer.id;
        const deployment = await createTestDeployment(customerId, { plan_key: FAKE_PLAN_KEY });
        deploymentId = deployment.id;

        await supabaseAdmin.from('plan_features').upsert(
            [{ plan_key: FAKE_PLAN_KEY, feature_key: 'whatsapp', enabled: true }],
            { onConflict: 'plan_key,feature_key' }
        );
    });

    afterAll(async () => {
        await supabaseAdmin.from('plan_features').delete().eq('plan_key', FAKE_PLAN_KEY);
        await cleanupDeployment(deploymentId);
        await cleanupCustomer(customerId);
    });

    it('rechaza sin autenticación de plataforma (contraparte: con x-platform-admin, funciona)', async () => {
        const app = await buildTestApp();
        try {
            const res = await app.inject({ method: 'POST', url: '/control/licenses', payload: { deploymentId } });
            expect(res.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('emite una licencia, deja registro en deployment_events y no permite emitir una segunda mientras la primera siga activa', async () => {
        const app = await buildTestApp();
        try {
            const res = await app.inject({
                method: 'POST',
                url: '/control/licenses',
                headers: { 'x-platform-admin': 'true' },
                payload: { deploymentId },
            });
            expect(res.statusCode).toBe(201);
            const body = res.json();
            expect(body.data.token).toBeTruthy();
            expect(body.data.deployment_id).toBe(deploymentId);

            const { data: events } = await supabaseAdmin
                .from('deployment_events')
                .select('event_type')
                .eq('deployment_id', deploymentId)
                .eq('event_type', 'licencia_emitida');
            expect(events?.length).toBeGreaterThanOrEqual(1);

            // Contraparte de rechazo: una segunda emisión sobre el mismo
            // despliegue, con licencia activa, se rechaza con 409.
            const secondRes = await app.inject({
                method: 'POST',
                url: '/control/licenses',
                headers: { 'x-platform-admin': 'true' },
                payload: { deploymentId },
            });
            expect(secondRes.statusCode).toBe(409);
        } finally {
            await app.close();
        }
    });

    it('GET no reexpone el token firmado', async () => {
        const app = await buildTestApp();
        try {
            const { data: license } = await supabaseAdmin.from('licenses').select('id').eq('deployment_id', deploymentId).is('revoked_at', null).single();
            const res = await app.inject({ method: 'GET', url: `/control/licenses/${license.id}`, headers: { 'x-platform-admin': 'true' } });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.token).toBeUndefined();
        } finally {
            await app.close();
        }
    });

    it('rota la licencia: la fila permanece, cambia el token, y se registra el evento "renovado"', async () => {
        const app = await buildTestApp();
        try {
            const { data: license } = await supabaseAdmin.from('licenses').select('*').eq('deployment_id', deploymentId).is('revoked_at', null).single();

            const res = await app.inject({
                method: 'POST',
                url: `/control/licenses/${license.id}/rotate`,
                headers: { 'x-platform-admin': 'true' },
                payload: {},
            });
            expect(res.statusCode).toBe(200);
            const rotated = res.json().data;
            expect(rotated.id).toBe(license.id);
            expect(rotated.token).not.toBe(license.token);

            const { data: events } = await supabaseAdmin
                .from('deployment_events')
                .select('event_type')
                .eq('deployment_id', deploymentId)
                .eq('event_type', 'renovado');
            expect(events?.length).toBeGreaterThanOrEqual(1);
        } finally {
            await app.close();
        }
    });

    it('revoca la licencia y registra el evento; una segunda revocación sobre la misma licencia falla con 404 (ya no está activa)', async () => {
        const app = await buildTestApp();
        try {
            const { data: license } = await supabaseAdmin.from('licenses').select('id').eq('deployment_id', deploymentId).is('revoked_at', null).single();

            const res = await app.inject({
                method: 'POST',
                url: `/control/licenses/${license.id}/revoke`,
                headers: { 'x-platform-admin': 'true' },
                payload: { reason: 'Cliente canceló el contrato.' },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.revoked_at).toBeTruthy();

            const secondRevoke = await app.inject({
                method: 'POST',
                url: `/control/licenses/${license.id}/revoke`,
                headers: { 'x-platform-admin': 'true' },
                payload: { reason: 'Intento repetido.' },
            });
            expect(secondRevoke.statusCode).toBe(404);

            const { data: events } = await supabaseAdmin
                .from('deployment_events')
                .select('event_type')
                .eq('deployment_id', deploymentId)
                .eq('event_type', 'licencia_revocada');
            expect(events?.length).toBeGreaterThanOrEqual(1);
        } finally {
            await app.close();
        }
    });

    it('rechaza revocar sin motivo', async () => {
        const app = await buildTestApp();
        try {
            const { data: anyLicense } = await supabaseAdmin.from('licenses').select('id').eq('deployment_id', deploymentId).limit(1).single();
            const res = await app.inject({
                method: 'POST',
                url: `/control/licenses/${anyLicense.id}/revoke`,
                headers: { 'x-platform-admin': 'true' },
                payload: {},
            });
            expect(res.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });
});
