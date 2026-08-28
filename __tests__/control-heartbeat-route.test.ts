import { describe, it, expect, afterAll } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { controlHeartbeatRoutes } from '../src/routes/control/heartbeat.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { issueLicense, revokeLicense } from '../src/services/license-service.js';
import { createTestCustomer, createTestDeployment, cleanupDeployment, cleanupCustomer } from './helpers/control-plane-fixtures.js';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(controlHeartbeatRoutes);
    await app.ready();
    return app;
}

const validPayload = {
    health: { installedVersion: '1.2.3', databaseOk: true, queueOk: true, toolLatencyP95Ms: 90, errorCount5xx: 0 },
    periodCounts: { conversations: 5, appointments: 2, prospects: 5 },
    usageUsdByProvider: { elevenlabs: 1.1 },
    activeFeatures: ['whatsapp'],
    seatsUsed: 1,
    fingerprint: null,
};

const fakeFastify = { supabaseAdmin, log: { warn: () => {}, error: () => {} } } as any;

describe('routes/control/heartbeat.ts (Fase B.2)', () => {
    const customerIds: string[] = [];
    const deploymentIds: string[] = [];

    afterAll(async () => {
        for (const id of deploymentIds) {
            await cleanupDeployment(id);
        }
        for (const id of customerIds) {
            await cleanupCustomer(id);
        }
    });

    // Un cliente solo puede tener un despliegue no-cancelado a la vez
    // (`ux_deployments_active_customer`, 55_control_plane_datagol.sql) —
    // cada caso de este archivo necesita su propio estado de licencia
    // aislado, así que cada uno crea también su propio cliente.
    async function newDeployment(): Promise<string> {
        const customer = await createTestCustomer();
        customerIds.push(customer.id);
        const deployment = await createTestDeployment(customer.id);
        deploymentIds.push(deployment.id);
        return deployment.id;
    }

    it('contraparte de éxito: un latido válido inserta license_heartbeats, actualiza last_heartbeat_at y responde con token renovado', async () => {
        const deploymentId = await newDeployment();
        const { rawToken, license } = await issueLicense(fakeFastify, { deploymentId });
        const app = await buildTestApp();

        try {
            const res = await app.inject({
                method: 'POST',
                url: `/control/deployments/${deploymentId}/heartbeat`,
                headers: { authorization: `Bearer ${rawToken}` },
                payload: validPayload,
            });

            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.token).toBeTruthy();
            expect(body.token).not.toBe(rawToken);

            const { data: heartbeats } = await supabaseAdmin.from('license_heartbeats').select('*').eq('license_id', license.id);
            expect(heartbeats?.length).toBe(1);
            expect(heartbeats?.[0].health.installedVersion).toBe('1.2.3');
            expect(heartbeats?.[0].metrics.periodCounts.conversations).toBe(5);

            const { data: updatedLicense } = await supabaseAdmin.from('licenses').select('last_heartbeat_at').eq('id', license.id).single();
            expect(updatedLicense.last_heartbeat_at).toBeTruthy();
        } finally {
            await app.close();
        }
    });

    it('rechaza un payload con un campo de PII con 400, sin insertar ningún latido', async () => {
        const deploymentId = await newDeployment();
        const { rawToken } = await issueLicense(fakeFastify, { deploymentId });
        const app = await buildTestApp();

        try {
            const res = await app.inject({
                method: 'POST',
                url: `/control/deployments/${deploymentId}/heartbeat`,
                headers: { authorization: `Bearer ${rawToken}` },
                payload: { ...validPayload, contacts: [{ name: 'Fuga de PII' }] },
            });
            expect(res.statusCode).toBe(400);

            const { data: heartbeats } = await supabaseAdmin.from('license_heartbeats').select('id').eq('deployment_id', deploymentId);
            expect(heartbeats?.length ?? 0).toBe(0);
        } finally {
            await app.close();
        }
    });

    it('rechaza sin Authorization Bearer', async () => {
        const deploymentId = await newDeployment();
        const app = await buildTestApp();
        try {
            const res = await app.inject({ method: 'POST', url: `/control/deployments/${deploymentId}/heartbeat`, payload: validPayload });
            expect(res.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('una licencia revocada no puede renovarse a sí misma vía latido', async () => {
        const deploymentId = await newDeployment();
        const { rawToken, license } = await issueLicense(fakeFastify, { deploymentId });
        await revokeLicense(fakeFastify, { licenseId: license.id, reason: 'prueba' });
        const app = await buildTestApp();

        try {
            const res = await app.inject({
                method: 'POST',
                url: `/control/deployments/${deploymentId}/heartbeat`,
                headers: { authorization: `Bearer ${rawToken}` },
                payload: validPayload,
            });
            // El JWT en sí sigue siendo criptográficamente válido (no venció
            // por firma), pero la licencia está revocada en la base — el
            // receptor debe rechazar, nunca dejar que un token revocado se
            // auto-renueve.
            expect(res.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });
});
