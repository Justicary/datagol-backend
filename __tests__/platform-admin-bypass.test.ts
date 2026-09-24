import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { isPlatformAdmin, isDevAdminBypassEnabled } from '../src/lib/platform-admin.js';

/**
 * El atajo `x-platform-admin: true` autentica como superadmin SIN token.
 * Solo puede funcionar con ALLOW_DEV_ADMIN_BYPASS=true y NODE_ENV distinto
 * de 'production'; en cualquier otro caso el header se ignora.
 */

const originalFlag = process.env.ALLOW_DEV_ADMIN_BYPASS;
const originalNodeEnv = process.env.NODE_ENV;

function setEnv(flag: string | undefined, nodeEnv: string | undefined) {
    if (flag === undefined) delete process.env.ALLOW_DEV_ADMIN_BYPASS;
    else process.env.ALLOW_DEV_ADMIN_BYPASS = flag;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
}

async function buildApp() {
    const app = Fastify({ logger: false });
    app.addHook('preHandler', isPlatformAdmin);
    app.get('/admin-only', async () => ({ ok: true }));
    await app.ready();
    return app;
}

afterEach(() => {
    setEnv(originalFlag, originalNodeEnv);
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('src/lib/platform-admin.ts — atajo x-platform-admin', () => {
    it.each([
        ['true', 'development', true],
        ['true', 'test', true],
        ['true', undefined, true],
        ['true', 'production', false],
        ['false', 'development', false],
        [undefined, 'development', false],
        ['TRUE', 'development', false],
        ['1', 'development', false],
    ])('ALLOW_DEV_ADMIN_BYPASS=%s, NODE_ENV=%s → habilitado=%s', (flag, nodeEnv, expected) => {
        setEnv(flag, nodeEnv);
        expect(isDevAdminBypassEnabled()).toBe(expected);
    });

    it('habilitado (desarrollo): el header deja pasar sin token', async () => {
        setEnv('true', 'development');
        const app = await buildApp();
        try {
            const res = await app.inject({ method: 'GET', url: '/admin-only', headers: { 'x-platform-admin': 'true' } });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ ok: true });
        } finally {
            await app.close();
        }
    });

    it.each([
        ['producción aunque la bandera esté encendida', 'true', 'production'],
        ['bandera ausente', undefined, 'development'],
        ['bandera en false', 'false', 'development'],
    ])('%s: el header se ignora y se exige token (401)', async (_label, flag, nodeEnv) => {
        setEnv(flag, nodeEnv);
        const app = await buildApp();
        try {
            const res = await app.inject({ method: 'GET', url: '/admin-only', headers: { 'x-platform-admin': 'true' } });
            expect(res.statusCode).toBe(401);
            expect(res.json().message).toBe('Se requiere token de autenticación para acceder a rutas administrativas.');
        } finally {
            await app.close();
        }
    });

    it('el intento rechazado queda registrado con ip y ruta', async () => {
        setEnv(undefined, 'production');
        const lines: string[] = [];
        const app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => lines.push(line) } } });
        app.addHook('preHandler', isPlatformAdmin);
        app.get('/admin-only', async () => ({ ok: true }));
        await app.ready();
        try {
            await app.inject({ method: 'GET', url: '/admin-only', headers: { 'x-platform-admin': 'true' } });
            const entry = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => typeof l.msg === 'string' && l.msg.includes('x-platform-admin'));
            expect(entry).toMatchObject({
                level: 40,
                url: '/admin-only',
                ip: '127.0.0.1',
                msg: 'Header x-platform-admin ignorado: el atajo de desarrollo no está habilitado',
            });
        } finally {
            await app.close();
        }
    });

    it('un header con otro valor nunca habilita el atajo', async () => {
        setEnv('true', 'development');
        const app = await buildApp();
        try {
            const res = await app.inject({ method: 'GET', url: '/admin-only', headers: { 'x-platform-admin': 'yes' } });
            expect(res.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });
});

describe('src/config/env.ts — ALLOW_DEV_ADMIN_BYPASS al arrancar', () => {
    it('producción con la bandera encendida → validateEnv lanza (la app no arranca)', async () => {
        setEnv('true', 'production');
        vi.resetModules();
        const { validateEnv } = await import('../src/config/env.js');
        expect(() => validateEnv()).toThrow(/ALLOW_DEV_ADMIN_BYPASS=true con NODE_ENV=production/);
    });

    it('contraparte: producción con la bandera apagada arranca y la expone en false', async () => {
        setEnv(undefined, 'production');
        vi.resetModules();
        const { validateEnv } = await import('../src/config/env.js');
        expect(validateEnv().ALLOW_DEV_ADMIN_BYPASS).toBe(false);
    });

    it('desarrollo con la bandera encendida arranca y la expone en true', async () => {
        setEnv('true', 'development');
        vi.resetModules();
        const { validateEnv } = await import('../src/config/env.js');
        expect(validateEnv().ALLOW_DEV_ADMIN_BYPASS).toBe(true);
    });
});
