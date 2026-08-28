import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { statusRoutes } from '../src/routes/status.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { clearRateLimiterForTesting } from '../src/lib/rate-limiter.js';
import { createTestCustomer, createTestDeployment, cleanupDeployment, cleanupCustomer } from './helpers/control-plane-fixtures.js';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(statusRoutes);
    await app.ready();
    return app;
}

describe('routes/status.ts (Fase E)', () => {
    let customerId: string;
    let deploymentId: string;
    let statusToken: string;

    beforeAll(async () => {
        clearRateLimiterForTesting();
        const customer = await createTestCustomer({ trade_name: 'Clínica de Prueba', rfc: 'XAXX010101000' });
        customerId = customer.id;
        const deployment = await createTestDeployment(customerId, { setup_fee_mxn: 5000, retainer_mxn: 2000, internal_notes: 'nota interna secreta' });
        deploymentId = deployment.id;
        statusToken = deployment.status_token;

        await supabaseAdmin.from('provisioning_tasks').insert([
            { deployment_id: deploymentId, task_key: 'contrato_firmado', label: 'Contrato firmado', owner: 'cliente', status: 'completada' },
            { deployment_id: deploymentId, task_key: 'did_activo', label: 'Número activo', owner: 'externo', status: 'pendiente' },
        ]);
    });

    afterAll(async () => {
        await cleanupDeployment(deploymentId);
        await cleanupCustomer(customerId);
        clearRateLimiterForTesting();
    });

    it('contraparte de éxito: token válido devuelve trade_name, avance y tareas — nunca montos ni notas internas', async () => {
        const app = await buildTestApp();
        try {
            const res = await app.inject({ method: 'GET', url: `/status/${statusToken}` });
            expect(res.statusCode).toBe(200);
            const body = res.json().data;

            expect(body.tradeName).toBe('Clínica de Prueba');
            expect(body.tasks.length).toBe(2);
            expect(body.progress.total).toBe(2);
            expect(body.progress.completadas).toBe(1);

            const raw = JSON.stringify(body);
            expect(raw).not.toContain('5000');
            expect(raw).not.toContain('2000');
            expect(raw).not.toContain('nota interna secreta');
            expect(raw).not.toContain('XAXX010101000');
        } finally {
            await app.close();
        }
    });

    it('token inexistente responde 404 genérico, sin distinguir de un formato inválido', async () => {
        const app = await buildTestApp();
        try {
            const resNonExistent = await app.inject({ method: 'GET', url: `/status/${'a'.repeat(48)}` });
            const resMalformed = await app.inject({ method: 'GET', url: '/status/corto' });

            expect(resNonExistent.statusCode).toBe(404);
            expect(resMalformed.statusCode).toBe(404);
            expect(resNonExistent.json().message).toBe(resMalformed.json().message);
        } finally {
            await app.close();
        }
    });

    it('aplica límite de tasa por token: pasado el umbral, responde 429', async () => {
        clearRateLimiterForTesting();
        const app = await buildTestApp();
        try {
            let lastStatus = 0;
            for (let i = 0; i < 25; i++) {
                const res = await app.inject({ method: 'GET', url: `/status/${statusToken}` });
                lastStatus = res.statusCode;
            }
            expect(lastStatus).toBe(429);
        } finally {
            await app.close();
            clearRateLimiterForTesting();
        }
    });
});
