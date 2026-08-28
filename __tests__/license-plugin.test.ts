import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import licensePlugin from '../src/plugins/license.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { issueLicense } from '../src/services/license-service.js';
import { createTestCustomer, createTestDeployment, cleanupDeployment, cleanupCustomer } from './helpers/control-plane-fixtures.js';

const fakeFastify = { supabaseAdmin, log: { warn: () => {}, error: () => {} } } as any;

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(licensePlugin);
    app.get('/probe', async (request, reply) => reply.send({ status: request.licenseStage }));
    await app.ready();
    return app;
}

/**
 * Fase B.1 — "sin token, o con firma inválida: la instalación arranca
 * igual... nunca rehúsa arrancar". Se ejercita el PLUGIN completo (no solo
 * `verifyLicenseToken` en aislamiento), incluida la fila real de
 * `license_client_state`.
 */
describe('plugins/license.ts (Fase B.1)', () => {
    afterEach(async () => {
        await supabaseAdmin.from('license_client_state').delete().eq('id', true);
    });

    it('contraparte de rechazo: sin ninguna fila en license_client_state, arranca igual en el estado más degradado', async () => {
        await supabaseAdmin.from('license_client_state').delete().eq('id', true);
        const app = await buildTestApp();
        try {
            expect(app.license.status).toBe('sin_token');
            const res = await app.inject({ method: 'GET', url: '/probe' });
            expect(res.statusCode).toBe(200);
            expect(res.json().status).toBe('dashboard_bloqueado');
        } finally {
            await app.close();
        }
    });

    it('contraparte de rechazo: con un token corrupto persistido, arranca igual en estado degradado (nunca lanza)', async () => {
        await supabaseAdmin.from('license_client_state').upsert(
            { id: true, token: 'esto-no-es-un-jwt-valido', key_version: 'v1', deployment_id: 'd1' },
            { onConflict: 'id' }
        );
        const app = await buildTestApp();
        try {
            expect(app.license.status).toBe('sin_token');
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: con un token real y vigente, el estado queda en "valida" y la etapa en "normal"', async () => {
        const customer = await createTestCustomer();
        const deployment = await createTestDeployment(customer.id);
        try {
            const { rawToken } = await issueLicense(fakeFastify, { deploymentId: deployment.id });
            await supabaseAdmin.from('license_client_state').upsert(
                { id: true, token: rawToken, key_version: 'v1', deployment_id: deployment.id, expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString() },
                { onConflict: 'id' }
            );

            const app = await buildTestApp();
            try {
                expect(app.license.status).toBe('valida');
                const res = await app.inject({ method: 'GET', url: '/probe' });
                expect(res.json().status).toBe('normal');
            } finally {
                await app.close();
            }
        } finally {
            await cleanupDeployment(deployment.id);
            await cleanupCustomer(customer.id);
        }
    });
});
