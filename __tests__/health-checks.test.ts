import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';

vi.mock('../src/plugins/supabase.js', async () => {
    const fp = (await import('fastify-plugin')).default;
    const plugin = fp(async (fastify: any) => {
        fastify.decorate('supabaseAdmin', {
            from: vi.fn(),
        });
    }, { name: 'supabase-plugin' });
    return {
        default: plugin,
        supabasePlugin: plugin,
    };
});

vi.mock('../src/plugins/pg-boss.js', async () => {
    const fp = (await import('fastify-plugin')).default;
    const plugin = fp(async (fastify: any) => {
        fastify.decorate('pgBoss', {
            getQueues: vi.fn(),
        });
    }, { name: 'pg-boss-plugin' });
    return {
        default: plugin,
        pgBossPlugin: plugin,
    };
});

vi.mock('../src/plugins/entitlements-plugin.js', async () => {
    const fp = (await import('fastify-plugin')).default;
    const plugin = fp(async () => {}, { name: 'entitlements-plugin' });
    return {
        default: plugin,
        entitlementsPlugin: plugin,
    };
});

vi.mock('../src/jobs/index.js', () => ({
    registerJobs: async () => {},
}));

describe('Health and Readiness Probes (/health & /ready)', () => {
    let app: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        app = await buildApp();
    });

    describe('GET /health (Liveness Probe)', () => {
        it('debe responder 200 OK con status ok sin consultar dependencias', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/health',
            });

            expect(res.statusCode).toBe(200);
            const payload = JSON.parse(res.payload);
            expect(payload.status).toBe('ok');
            expect(payload.service).toBe('datagol-backend');
            expect(payload.timestamp).toBeDefined();
        });
    });

    describe('GET /ready (Readiness Probe)', () => {
        it('debe devolver 200 OK cuando la BD y la cola responden correctamente', async () => {
            // Mock DB exitoso
            app.supabaseAdmin.from.mockReturnValue({
                select: vi.fn().mockResolvedValue({ count: 1, error: null }),
            });
            // Mock pg-boss exitoso
            app.pgBoss.getQueues.mockResolvedValue([]);

            const res = await app.inject({
                method: 'GET',
                url: '/ready',
            });

            expect(res.statusCode).toBe(200);
            const payload = JSON.parse(res.payload);
            expect(payload.status).toBe('ok');
            expect(payload.database).toBe('connected');
            expect(payload.queue).toBe('connected');
            expect(payload.errors).toBeUndefined();
        });

        it('debe devolver 503 Service Unavailable si la Base de Datos falla', async () => {
            // Mock DB fallida
            app.supabaseAdmin.from.mockReturnValue({
                select: vi.fn().mockResolvedValue({ count: null, error: { message: 'DB connection timeout' } }),
            });
            // Mock pg-boss exitoso
            app.pgBoss.getQueues.mockResolvedValue([]);

            const res = await app.inject({
                method: 'GET',
                url: '/ready',
            });

            expect(res.statusCode).toBe(503);
            const payload = JSON.parse(res.payload);
            expect(payload.status).toBe('unhealthy');
            expect(payload.database).toBe('disconnected');
            expect(payload.queue).toBe('connected');
            expect(payload.errors.database).toBe('DB connection timeout');
        });

        it('debe devolver 503 Service Unavailable si la Cola pg-boss falla', async () => {
            // Mock DB exitoso
            app.supabaseAdmin.from.mockReturnValue({
                select: vi.fn().mockResolvedValue({ count: 1, error: null }),
            });
            // Mock pg-boss fallido
            app.pgBoss.getQueues.mockRejectedValue(new Error('PostgreSQL queue pool error'));

            const res = await app.inject({
                method: 'GET',
                url: '/ready',
            });

            expect(res.statusCode).toBe(503);
            const payload = JSON.parse(res.payload);
            expect(payload.status).toBe('unhealthy');
            expect(payload.database).toBe('connected');
            expect(payload.queue).toBe('disconnected');
            expect(payload.errors.queue).toBe('PostgreSQL queue pool error');
        });
    });
});
