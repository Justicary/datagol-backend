import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { adminSsoRoutes } from '../src/routes/admin/sso.js';
import { signAdminPassport, clearUsedJtiForTesting } from '../src/lib/admin-passport.js';
import { setTestAdminPassportKeyEnv } from './helpers/test-license-keys.js';

const DEPLOYMENT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_DEPLOYMENT_ID = '44444444-4444-4444-8444-444444444444';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(adminSsoRoutes);
    await app.ready();
    return app;
}

describe('routes/admin/sso.ts (canje de pase → sesión local)', () => {
    const originalDeploymentId = process.env.DEPLOYMENT_ID;
    const originalSessionSecret = process.env.ADMIN_SESSION_SECRET;

    beforeAll(async () => {
        await setTestAdminPassportKeyEnv('v1');
    });

    afterEach(() => {
        process.env.DEPLOYMENT_ID = originalDeploymentId;
        process.env.ADMIN_SESSION_SECRET = originalSessionSecret;
        vi.resetModules();
        clearUsedJtiForTesting();
    });

    it('rechaza sin body', async () => {
        process.env.DEPLOYMENT_ID = DEPLOYMENT_ID;
        process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba';
        const app = await buildTestApp();
        try {
            const res = await app.inject({ method: 'POST', url: '/api/admin/sso/exchange', payload: {} });
            expect(res.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('responde 500 claro si esta instalación no tiene DEPLOYMENT_ID configurado', async () => {
        delete process.env.DEPLOYMENT_ID;
        process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba';
        vi.resetModules();
        const { adminSsoRoutes: fresh } = await import('../src/routes/admin/sso.js');
        const app = Fastify({ logger: false });
        await app.register(supabasePlugin);
        await app.register(fresh);
        await app.ready();
        try {
            const res = await app.inject({ method: 'POST', url: '/api/admin/sso/exchange', payload: { passport: 'x' } });
            expect(res.statusCode).toBe(500);
            expect(res.json().message).toMatch(/DEPLOYMENT_ID/);
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: un pase válido para esta instalación se canjea por una sesión local, y whoami la reconoce', async () => {
        process.env.DEPLOYMENT_ID = DEPLOYMENT_ID;
        process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba';
        vi.resetModules();
        const { adminSsoRoutes: fresh } = await import('../src/routes/admin/sso.js');
        const { signAdminPassport: freshSign } = await import('../src/lib/admin-passport.js');
        const app = Fastify({ logger: false });
        await app.register(supabasePlugin);
        await app.register(fresh);
        await app.ready();
        try {
            const passport = await freshSign({ sub: 'user-1', email: 'dev@datagol.net', deploymentId: DEPLOYMENT_ID });

            const exchangeRes = await app.inject({ method: 'POST', url: '/api/admin/sso/exchange', payload: { passport: passport.token } });
            expect(exchangeRes.statusCode).toBe(200);
            const sessionToken = exchangeRes.json().data.sessionToken;
            expect(sessionToken).toBeTruthy();

            const whoamiRes = await app.inject({ method: 'GET', url: '/api/admin/sso/whoami', headers: { authorization: `Bearer ${sessionToken}` } });
            expect(whoamiRes.statusCode).toBe(200);
            expect(whoamiRes.json().data.email).toBe('dev@datagol.net');
        } finally {
            await app.close();
        }
    });

    it('PRUEBA CENTRAL: un pase emitido para OTRO despliegue se rechaza aquí (aud no coincide con DEPLOYMENT_ID propio)', async () => {
        process.env.DEPLOYMENT_ID = DEPLOYMENT_ID;
        process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba';
        vi.resetModules();
        const { adminSsoRoutes: fresh } = await import('../src/routes/admin/sso.js');
        const { signAdminPassport: freshSign } = await import('../src/lib/admin-passport.js');
        const app = Fastify({ logger: false });
        await app.register(supabasePlugin);
        await app.register(fresh);
        await app.ready();
        try {
            const passportForOther = await freshSign({ sub: 'user-1', email: 'dev@datagol.net', deploymentId: OTHER_DEPLOYMENT_ID });
            const res = await app.inject({ method: 'POST', url: '/api/admin/sso/exchange', payload: { passport: passportForOther.token } });
            expect(res.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('un pase reutilizado se rechaza en el segundo canje', async () => {
        process.env.DEPLOYMENT_ID = DEPLOYMENT_ID;
        process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba';
        vi.resetModules();
        const { adminSsoRoutes: fresh } = await import('../src/routes/admin/sso.js');
        const { signAdminPassport: freshSign } = await import('../src/lib/admin-passport.js');
        const app = Fastify({ logger: false });
        await app.register(supabasePlugin);
        await app.register(fresh);
        await app.ready();
        try {
            const passport = await freshSign({ sub: 'user-1', email: 'dev@datagol.net', deploymentId: DEPLOYMENT_ID });
            const first = await app.inject({ method: 'POST', url: '/api/admin/sso/exchange', payload: { passport: passport.token } });
            expect(first.statusCode).toBe(200);

            const second = await app.inject({ method: 'POST', url: '/api/admin/sso/exchange', payload: { passport: passport.token } });
            expect(second.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('whoami rechaza un Bearer que no es una sesión local válida (cae al camino de Supabase Auth, que también rechaza un token basura)', async () => {
        process.env.DEPLOYMENT_ID = DEPLOYMENT_ID;
        process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba';
        vi.resetModules();
        const { adminSsoRoutes: fresh } = await import('../src/routes/admin/sso.js');
        const app = Fastify({ logger: false });
        await app.register(supabasePlugin);
        await app.register(fresh);
        await app.ready();
        try {
            const res = await app.inject({ method: 'GET', url: '/api/admin/sso/whoami', headers: { authorization: 'Bearer token-basura-no-es-nada-valido' } });
            expect(res.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });
});
