import { describe, it, expect, vi, afterEach } from 'vitest';
import { setTestLicenseKeyEnv } from './helpers/test-license-keys.js';

/**
 * Fase F — "arrancar con la bandera apagada y verificar que toda ruta de
 * /control/** devuelva 404. Es la prueba que evita el peor escenario de
 * esta tarea." Mismo patrón de mocking de infraestructura que
 * __tests__/health-checks.test.ts: se aísla del Supabase/pg-boss reales
 * porque lo que se prueba aquí es el REGISTRO de rutas, no su lógica.
 */
vi.mock('../src/plugins/supabase.js', async () => {
    const fp = (await import('fastify-plugin')).default;
    const plugin = fp(async (fastify: any) => {
        fastify.decorate('supabaseAdmin', { from: vi.fn() });
        fastify.decorate('supabaseUser', () => ({ from: vi.fn() }));
    }, { name: 'supabase-plugin' });
    return { default: plugin, supabasePlugin: plugin };
});

vi.mock('../src/plugins/pg-boss.js', async () => {
    const fp = (await import('fastify-plugin')).default;
    const plugin = fp(async (fastify: any) => {
        fastify.decorate('pgBoss', { getQueues: vi.fn().mockResolvedValue([]) });
    }, { name: 'pg-boss-plugin' });
    return { default: plugin, pgBossPlugin: plugin };
});

vi.mock('../src/plugins/entitlements.js', async () => {
    const fp = (await import('fastify-plugin')).default;
    const plugin = fp(async () => {}, { name: 'entitlements-plugin' });
    return { default: plugin, entitlementsPlugin: plugin };
});

vi.mock('../src/jobs/index.js', () => ({
    registerJobs: async () => {},
}));

const ORIGINAL_ENV = { ...process.env };

describe('Fase F — aislamiento de CONTROL_PLANE', () => {
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        vi.resetModules();
    });

    it('con CONTROL_PLANE=false, cada ruta /control/** responde 404 (no se registró)', async () => {
        process.env.CONTROL_PLANE = 'false';
        vi.resetModules();
        const { buildApp } = await import('../src/app.js');
        const app = await buildApp();
        await app.ready();
        try {
            const routesToProbe = [
                { method: 'POST' as const, url: '/control/licenses' },
                { method: 'GET' as const, url: '/control/customers' },
                { method: 'GET' as const, url: '/control/deployments' },
                { method: 'GET' as const, url: '/control/fleet' },
                { method: 'POST' as const, url: '/control/deployments/00000000-0000-0000-0000-000000000000/contract' },
                { method: 'GET' as const, url: '/status/some-token-value-1234567890' },
            ];

            for (const probe of routesToProbe) {
                const res = await app.inject({ method: probe.method, url: probe.url, headers: { 'x-platform-admin': 'true' } });
                expect(res.statusCode, `${probe.method} ${probe.url}`).toBe(404);
                // Es el 404 genérico de Fastify por ruta inexistente, no el 404
                // de negocio de un handler real (que traería `error` propio).
                expect(res.json().message).toMatch(/Route .* not found/i);
            }
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: con CONTROL_PLANE=true y llaves configuradas, las rutas SÍ existen (responden con lógica propia, no 404 genérico)', async () => {
        process.env.CONTROL_PLANE = 'true';
        await setTestLicenseKeyEnv('v1');
        vi.resetModules();
        const { buildApp } = await import('../src/app.js');
        const app = await buildApp();
        await app.ready();
        try {
            const res = await app.inject({
                method: 'GET',
                url: '/control/customers',
                headers: { 'x-platform-admin': 'true' },
            });
            // La ruta existe: responde según su propia lógica (aquí, un error
            // de Supabase mockeado devuelve 500 con nuestro propio shape), en
            // vez del 404 genérico de "Route ... not found" de Fastify.
            expect(res.statusCode).not.toBe(404);
        } finally {
            await app.close();
        }
    });

    it('CONTROL_PLANE=true sin llaves de firma configuradas falla al arrancar con mensaje claro (Fase F)', async () => {
        process.env.CONTROL_PLANE = 'true';
        delete process.env.CONTROL_PLANE_SIGNING_KEYS;
        delete process.env.LICENSE_PUBLIC_KEYS;
        vi.resetModules();
        // `lib/supabase.ts` llama a validateEnv() en su nivel de módulo, así
        // que el fallo ocurre durante el propio `import()` — no dentro de
        // `buildApp()` — porque ya sabemos (Fase F) que debe fallar lo antes
        // posible, nunca a mitad de una llamada.
        await expect(import('../src/app.js')).rejects.toThrow(/CONTROL_PLANE_SIGNING_KEYS/);
    });
});
