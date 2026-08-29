import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { controlDeploymentsRoutes } from '../src/routes/control/deployments.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { createTestCustomer, createTestDeployment, cleanupDeployment, cleanupCustomer } from './helpers/control-plane-fixtures.js';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(controlDeploymentsRoutes);
    await app.ready();
    return app;
}

/**
 * Sub-recursos de solo lectura de /control/deployments/:id/* añadidos para
 * el detalle de flota del frontend (docs/tasks/control-plane-frontend-datagol.md
 * §1/§2) — contratos, licencia, latidos y bitácora. Sin capa de servicio,
 * mismo criterio que /control/fleet: se prueban aquí directamente contra
 * filas insertadas a mano, no contra los flujos de negocio de
 * contracts.ts/licenses.ts (ya cubiertos en sus propios archivos de prueba).
 */
describe('routes/control/deployments.ts — sub-recursos de historial', () => {
    let customerId: string;
    let deploymentId: string;
    let contractId: string;
    let licenseId: string;

    beforeAll(async () => {
        const customer = await createTestCustomer();
        customerId = customer.id;
        const deployment = await createTestDeployment(customerId);
        deploymentId = deployment.id;

        const { data: contract, error: contractError } = await supabaseAdmin
            .from('contracts')
            .insert({
                deployment_id: deploymentId,
                template_version: 'v1',
                document_hash: 'hash-de-prueba',
                signer_name: 'Firmante de Prueba',
                signer_email: 'firmante@example.invalid',
            })
            .select('*')
            .single();
        if (contractError || !contract) throw new Error(`No se pudo crear contrato de prueba: ${contractError?.message}`);
        contractId = contract.id;

        const { data: license, error: licenseError } = await supabaseAdmin
            .from('licenses')
            .insert({
                deployment_id: deploymentId,
                token: 'jwt-secreto-de-prueba',
                key_version: 'v1',
                expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            })
            .select('*')
            .single();
        if (licenseError || !license) throw new Error(`No se pudo crear licencia de prueba: ${licenseError?.message}`);
        licenseId = license.id;

        await supabaseAdmin.from('license_heartbeats').insert({
            license_id: licenseId,
            deployment_id: deploymentId,
            installed_version: '1.0.0',
            health: {},
            metrics: {},
        });

        await supabaseAdmin.from('deployment_events').insert({
            deployment_id: deploymentId,
            event_type: 'nota',
            description: 'Evento de prueba',
        });
    });

    afterAll(async () => {
        if (deploymentId) await cleanupDeployment(deploymentId);
        if (customerId) await cleanupCustomer(customerId);
    });

    it('GET /control/deployments/:id/contracts lista el contrato creado', async () => {
        const app = await buildTestApp();
        try {
            const res = await app.inject({
                method: 'GET',
                url: `/control/deployments/${deploymentId}/contracts`,
                headers: { 'x-platform-admin': 'true' },
            });
            expect(res.statusCode).toBe(200);
            const rows = res.json().data;
            expect(rows.some((c: any) => c.id === contractId)).toBe(true);
        } finally {
            await app.close();
        }
    });

    it('GET /control/deployments/:id/license lista la licencia sin exponer el token', async () => {
        const app = await buildTestApp();
        try {
            const res = await app.inject({
                method: 'GET',
                url: `/control/deployments/${deploymentId}/license`,
                headers: { 'x-platform-admin': 'true' },
            });
            expect(res.statusCode).toBe(200);
            const rows = res.json().data;
            const row = rows.find((l: any) => l.id === licenseId);
            expect(row).toBeTruthy();
            expect(row.token).toBeUndefined();
        } finally {
            await app.close();
        }
    });

    it('GET /control/deployments/:id/heartbeats devuelve el latido insertado, más recientes primero', async () => {
        const app = await buildTestApp();
        try {
            const res = await app.inject({
                method: 'GET',
                url: `/control/deployments/${deploymentId}/heartbeats`,
                headers: { 'x-platform-admin': 'true' },
            });
            expect(res.statusCode).toBe(200);
            const rows = res.json().data;
            expect(rows.length).toBeGreaterThanOrEqual(1);
            expect(rows[0].installed_version).toBe('1.0.0');
        } finally {
            await app.close();
        }
    });

    it('GET /control/deployments/:id/events devuelve el evento insertado', async () => {
        const app = await buildTestApp();
        try {
            const res = await app.inject({
                method: 'GET',
                url: `/control/deployments/${deploymentId}/events`,
                headers: { 'x-platform-admin': 'true' },
            });
            expect(res.statusCode).toBe(200);
            const rows = res.json().data;
            expect(rows.some((e: any) => e.event_type === 'nota' && e.description === 'Evento de prueba')).toBe(true);
        } finally {
            await app.close();
        }
    });

    it('un despliegue sin historial responde 200 con listas vacías, no 404 (contraparte de éxito)', async () => {
        const app = await buildTestApp();
        try {
            // Cliente propio: un cliente no puede tener dos despliegues
            // activos a la vez (ux_deployments_active_customer).
            const emptyCustomer = await createTestCustomer();
            const emptyDeployment = await createTestDeployment(emptyCustomer.id);
            try {
                const res = await app.inject({
                    method: 'GET',
                    url: `/control/deployments/${emptyDeployment.id}/heartbeats`,
                    headers: { 'x-platform-admin': 'true' },
                });
                expect(res.statusCode).toBe(200);
                expect(res.json().data).toEqual([]);
            } finally {
                await cleanupDeployment(emptyDeployment.id);
                await cleanupCustomer(emptyCustomer.id);
            }
        } finally {
            await app.close();
        }
    });

    it('sin cabecera de superadmin, los 4 sub-recursos responden 401/403', async () => {
        const app = await buildTestApp();
        try {
            for (const suffix of ['contracts', 'license', 'heartbeats', 'events']) {
                const res = await app.inject({ method: 'GET', url: `/control/deployments/${deploymentId}/${suffix}` });
                expect([401, 403]).toContain(res.statusCode);
            }
        } finally {
            await app.close();
        }
    });
});
