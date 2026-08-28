import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { SignJWT } from 'jose';
import { signAdminSession, verifyAdminSession } from '../src/lib/admin-session.js';

describe('src/lib/admin-session.ts', () => {
    beforeAll(() => {
        if (!process.env.ADMIN_SESSION_SECRET) {
            process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-not-a-real-value';
        }
    });

    it('contraparte de éxito: firma y verifica una sesión local válida', async () => {
        const signed = await signAdminSession('dev@datagol.net');
        const result = await verifyAdminSession(signed.token);
        expect(result).toEqual({ valid: true, email: 'dev@datagol.net' });
    });

    it('rechaza sin token', async () => {
        const result = await verifyAdminSession(null);
        expect(result).toEqual({ valid: false });
    });

    it('rechaza un token firmado con OTRO secreto', async () => {
        const tokenFromElsewhere = await new SignJWT({ email: 'atacante@example.com' })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuer('datagol-admin-session')
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(new TextEncoder().encode('un-secreto-completamente-distinto'));

        const result = await verifyAdminSession(tokenFromElsewhere);
        expect(result).toEqual({ valid: false });
    });

    it('rechaza un token con issuer distinto (aunque use el mismo secreto)', async () => {
        const wrongIssuerToken = await new SignJWT({ email: 'dev@datagol.net' })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuer('otro-issuer')
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(new TextEncoder().encode(process.env.ADMIN_SESSION_SECRET as string));

        const result = await verifyAdminSession(wrongIssuerToken);
        expect(result).toEqual({ valid: false });
    });

    describe('sin ADMIN_SESSION_SECRET configurado', () => {
        // config/env.ts cachea validateEnv() a nivel de módulo — las pruebas
        // anteriores ya lo poblaron con ADMIN_SESSION_SECRET presente. Se
        // resetea el registro de módulos de Vitest y se reimporta en
        // caliente para forzar una relectura real de process.env (mismo
        // patrón que __tests__/license-signing.test.ts).
        const original = process.env.ADMIN_SESSION_SECRET;

        afterEach(() => {
            process.env.ADMIN_SESSION_SECRET = original;
            vi.resetModules();
        });

        it('firmar lanza un error claro', async () => {
            delete process.env.ADMIN_SESSION_SECRET;
            vi.resetModules();
            const fresh = await import('../src/lib/admin-session.js');
            await expect(fresh.signAdminSession('dev@datagol.net')).rejects.toThrow(/ADMIN_SESSION_SECRET/);
        });

        it('verificar nunca lanza — degrada a inválido', async () => {
            delete process.env.ADMIN_SESSION_SECRET;
            vi.resetModules();
            const fresh = await import('../src/lib/admin-session.js');
            const result = await fresh.verifyAdminSession('cualquier-token');
            expect(result).toEqual({ valid: false });
        });
    });
});
