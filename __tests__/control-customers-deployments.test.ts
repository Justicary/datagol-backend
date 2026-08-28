import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { controlCustomersRoutes } from '../src/routes/control/customers.js';
import { controlDeploymentsRoutes } from '../src/routes/control/deployments.js';
import { controlFleetRoutes } from '../src/routes/control/fleet.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { cleanupDeployment, cleanupCustomer } from './helpers/control-plane-fixtures.js';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(controlCustomersRoutes);
    await app.register(controlDeploymentsRoutes);
    await app.register(controlFleetRoutes);
    await app.ready();
    return app;
}

describe('routes/control/customers.ts + deployments.ts + fleet.ts (Fase C)', () => {
    let customerId: string;
    let deploymentId: string;

    afterAll(async () => {
        if (deploymentId) await cleanupDeployment(deploymentId);
        if (customerId) await cleanupCustomer(customerId);
    });

    it('crea un cliente, rechaza RFC con formato inválido (contraparte de éxito con RFC omitido)', async () => {
        const app = await buildTestApp();
        try {
            const badRfc = await app.inject({
                method: 'POST',
                url: '/control/customers',
                headers: { 'x-platform-admin': 'true' },
                payload: {
                    legalName: 'Clínica Dental del Valle SA de CV',
                    contactName: 'Ana Pérez',
                    contactEmail: `ana-${Date.now()}@example.invalid`,
                    rfc: 'RFC-INVALIDO',
                },
            });
            expect(badRfc.statusCode).toBe(400);

            const res = await app.inject({
                method: 'POST',
                url: '/control/customers',
                headers: { 'x-platform-admin': 'true' },
                payload: {
                    legalName: 'Clínica Dental del Valle SA de CV',
                    tradeName: 'Dental del Valle',
                    contactName: 'Ana Pérez',
                    contactEmail: `ana-${Date.now()}@example.invalid`,
                },
            });
            expect(res.statusCode).toBe(201);
            customerId = res.json().data.id;
        } finally {
            await app.close();
        }
    });

    it('crea un despliegue para el cliente y lo transiciona a aprovisionando, instanciando tareas filtradas por plan', async () => {
        const app = await buildTestApp();
        try {
            const createRes = await app.inject({
                method: 'POST',
                url: '/control/deployments',
                headers: { 'x-platform-admin': 'true' },
                payload: { customerId, slug: `dental-valle-${Date.now()}`, planKey: 'starter' },
            });
            expect(createRes.statusCode).toBe(201);
            deploymentId = createRes.json().data.id;
            expect(createRes.json().data.status).toBe('borrador');

            const statusRes = await app.inject({
                method: 'POST',
                url: `/control/deployments/${deploymentId}/status`,
                headers: { 'x-platform-admin': 'true' },
                payload: { status: 'aprovisionando' },
            });
            expect(statusRes.statusCode).toBe(200);

            const tasksRes = await app.inject({ method: 'GET', url: `/control/deployments/${deploymentId}/tasks`, headers: { 'x-platform-admin': 'true' } });
            expect(tasksRes.statusCode).toBe(200);
            const tasks = tasksRes.json().data;
            expect(tasks.length).toBeGreaterThan(0);
            expect(tasks.every((t: any) => t.status === 'pendiente')).toBe(true);

            const { data: events } = await supabaseAdmin
                .from('deployment_events')
                .select('event_type, previous_value, new_value')
                .eq('deployment_id', deploymentId)
                .eq('event_type', 'estado_cambiado');
            expect(events?.length).toBeGreaterThanOrEqual(1);
            expect(events?.[0].new_value).toBe('aprovisionando');
        } finally {
            await app.close();
        }
    });

    it('marca una tarea como completada (contraparte: la tarea con task_key inexistente responde 404)', async () => {
        const app = await buildTestApp();
        try {
            const notFound = await app.inject({
                method: 'PATCH',
                url: `/control/deployments/${deploymentId}/tasks/tarea-que-no-existe`,
                headers: { 'x-platform-admin': 'true' },
                payload: { status: 'completada' },
            });
            expect(notFound.statusCode).toBe(404);

            const { data: anyTask } = await supabaseAdmin.from('provisioning_tasks').select('task_key').eq('deployment_id', deploymentId).limit(1).single();
            const res = await app.inject({
                method: 'PATCH',
                url: `/control/deployments/${deploymentId}/tasks/${anyTask.task_key}`,
                headers: { 'x-platform-admin': 'true' },
                payload: { status: 'completada' },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.completed_at).toBeTruthy();

            const { data: completedEvents } = await supabaseAdmin
                .from('deployment_events')
                .select('id')
                .eq('deployment_id', deploymentId)
                .eq('event_type', 'tarea_completada');
            expect(completedEvents?.length).toBeGreaterThanOrEqual(1);
        } finally {
            await app.close();
        }
    });

    it('GET /control/fleet incluye el despliegue con su etapa de degradación', async () => {
        const app = await buildTestApp();
        try {
            const res = await app.inject({ method: 'GET', url: '/control/fleet', headers: { 'x-platform-admin': 'true' } });
            expect(res.statusCode).toBe(200);
            const row = res.json().data.find((d: any) => d.deployment_id === deploymentId);
            expect(row).toBeTruthy();
            expect(row.etapa_degradacion).toBeDefined();
        } finally {
            await app.close();
        }
    });
});
