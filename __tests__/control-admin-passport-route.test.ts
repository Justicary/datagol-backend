import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { controlAdminPassportRoutes } from '../src/routes/control/admin-passport.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { verifyAdminPassport, clearUsedJtiForTesting } from '../src/lib/admin-passport.js';
import { setTestAdminPassportKeyEnv } from './helpers/test-license-keys.js';
import { createTestCustomer, createTestDeployment, cleanupDeployment, cleanupCustomer } from './helpers/control-plane-fixtures.js';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(controlAdminPassportRoutes);
    await app.ready();
    return app;
}

/**
 * `isPlatformAdmin` (lib/platform-admin.ts) valida el Bearer contra
 * Supabase Auth real — se espía `auth.getUser` para simular un superadmin
 * CON correo real (a diferencia del atajo `x-platform-admin: true`, que
 * esta ruta rechaza a propósito por no tener a quién auditar). La consulta
 * a `organization_members` que sigue corre contra la base real y
 * simplemente no encuentra fila para este id falso — se resuelve a `null`
 * sin necesidad de mockearla también.
 */
// `deployment_events.actor_user_id` tiene FK a `auth.users(id)` — un UUID
// inventado la violaría. Se resuelve un usuario real existente una sola vez
// (no importa cuál; solo necesita existir) para que el mock de
// `auth.getUser` devuelva un id que la FK acepte.
let realAuthUserId: string;

function mockAuthenticatedAdmin(email = 'dev@datagol.net') {
    return vi.spyOn(supabaseAdmin.auth, 'getUser').mockResolvedValue({
        data: { user: { id: realAuthUserId, email, app_metadata: { is_platform_admin: true } } },
        error: null,
    } as any);
}

describe('routes/control/admin-passport.ts (SSO delegado)', () => {
    let customerId: string;
    let deploymentId: string;

    beforeAll(async () => {
        await setTestAdminPassportKeyEnv('v1');
        const { data: usersPage } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1 });
        if (!usersPage?.users?.length) {
            throw new Error('No hay ningún usuario real en auth.users contra el que satisfacer la FK de deployment_events.actor_user_id.');
        }
        realAuthUserId = usersPage.users[0].id;

        const customer = await createTestCustomer();
        customerId = customer.id;
        const deployment = await createTestDeployment(customerId, { install_url: 'https://cliente-demo.example.com' });
        deploymentId = deployment.id;
    });

    afterAll(async () => {
        await cleanupDeployment(deploymentId);
        await cleanupCustomer(customerId);
    });

    beforeEach(() => {
        vi.restoreAllMocks();
        clearUsedJtiForTesting();
    });

    it('rechaza sin autenticación', async () => {
        const app = await buildTestApp();
        try {
            const res = await app.inject({ method: 'POST', url: '/control/admin-passport', payload: { deploymentId } });
            expect(res.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('rechaza el atajo local x-platform-admin (sin correo real que auditar)', async () => {
        const app = await buildTestApp();
        try {
            const res = await app.inject({
                method: 'POST',
                url: '/control/admin-passport',
                headers: { 'x-platform-admin': 'true' },
                payload: { deploymentId },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/correo real/i);
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: emite un pase válido, deja registro en deployment_events, y construye la URL de callback', async () => {
        mockAuthenticatedAdmin('dev@datagol.net');
        const app = await buildTestApp();
        try {
            const res = await app.inject({
                method: 'POST',
                url: '/control/admin-passport',
                headers: { authorization: 'Bearer cualquier-token-la-verificacion-esta-mockeada' },
                payload: { deploymentId },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json().data;
            expect(body.callbackUrl).toMatch(/^https:\/\/cliente-demo\.example\.com\/admin\/sso\/callback\?passport=/);

            const passportToken = decodeURIComponent(body.callbackUrl.split('passport=')[1]);
            const verified = await verifyAdminPassport(passportToken, deploymentId);
            expect(verified.valid).toBe(true);
            if (verified.valid) {
                expect(verified.claims.email).toBe('dev@datagol.net');
            }

            const { data: events } = await supabaseAdmin
                .from('deployment_events')
                .select('event_type, description')
                .eq('deployment_id', deploymentId)
                .eq('event_type', 'pase_admin_emitido');
            expect(events?.length).toBeGreaterThanOrEqual(1);
            expect(events?.[0].description).toMatch(/dev@datagol\.net/);
        } finally {
            await app.close();
        }
    });

    it('rechaza un deploymentId inexistente', async () => {
        mockAuthenticatedAdmin('dev@datagol.net');
        const app = await buildTestApp();
        try {
            const res = await app.inject({
                method: 'POST',
                url: '/control/admin-passport',
                headers: { authorization: 'Bearer x' },
                payload: { deploymentId: '00000000-0000-0000-0000-000000000000' },
            });
            expect(res.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it('rechaza un despliegue sin install_url configurada', async () => {
        mockAuthenticatedAdmin('dev@datagol.net');
        const customer2 = await createTestCustomer();
        const deployment2 = await createTestDeployment(customer2.id);
        const app = await buildTestApp();
        try {
            const res = await app.inject({
                method: 'POST',
                url: '/control/admin-passport',
                headers: { authorization: 'Bearer x' },
                payload: { deploymentId: deployment2.id },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/install_url/);
        } finally {
            await app.close();
            await cleanupDeployment(deployment2.id);
            await cleanupCustomer(customer2.id);
        }
    });
});
