import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { SignJWT, importPKCS8 } from 'jose';
import { setTestAdminPassportKeyEnv, getTestAdminPassportKeyPair } from './helpers/test-license-keys.js';
import { signAdminPassport, verifyAdminPassport, clearUsedJtiForTesting } from '../src/lib/admin-passport.js';

const DEPLOYMENT_A = '11111111-1111-1111-1111-111111111111';
const DEPLOYMENT_B = '22222222-2222-2222-2222-222222222222';

describe('src/lib/admin-passport.ts', () => {
    beforeAll(async () => {
        await setTestAdminPassportKeyEnv('v1');
    });

    afterEach(() => {
        clearUsedJtiForTesting();
    });

    it('contraparte de éxito: firma y verifica un pase válido para el despliegue correcto', async () => {
        const signed = await signAdminPassport({ sub: 'user-1', email: 'dev@datagol.net', deploymentId: DEPLOYMENT_A });
        const result = await verifyAdminPassport(signed.token, DEPLOYMENT_A);
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.claims.email).toBe('dev@datagol.net');
            expect(result.claims.deploymentId).toBe(DEPLOYMENT_A);
        }
    });

    it('rechaza sin token', async () => {
        const result = await verifyAdminPassport(null, DEPLOYMENT_A);
        expect(result).toEqual({ valid: false, reason: 'sin_token' });
    });

    it('PRUEBA CENTRAL: un pase emitido para el despliegue A se rechaza al verificarlo contra el despliegue B', async () => {
        const signed = await signAdminPassport({ sub: 'user-1', email: 'dev@datagol.net', deploymentId: DEPLOYMENT_A });
        const result = await verifyAdminPassport(signed.token, DEPLOYMENT_B);
        expect(result.valid).toBe(false);
    });

    it('un pase ya usado (mismo jti) se rechaza en el segundo intento — contraparte: el primer uso sí funciona', async () => {
        const signed = await signAdminPassport({ sub: 'user-1', email: 'dev@datagol.net', deploymentId: DEPLOYMENT_A });

        const first = await verifyAdminPassport(signed.token, DEPLOYMENT_A);
        expect(first.valid).toBe(true);

        const second = await verifyAdminPassport(signed.token, DEPLOYMENT_A);
        expect(second).toEqual({ valid: false, reason: 'ya_usado' });
    });

    it('un pase expirado (pero legítimamente firmado) se rechaza con el motivo "expirado"', async () => {
        // signAdminPassport() fija la vigencia en 5 min sin parámetro para
        // variarla — se firma un token real, legítimo, con la MISMA llave
        // privada de prueba pero un `exp` ya vencido, para probar
        // exclusivamente la rama de expiración (no una firma corrupta).
        const { privatePem } = await getTestAdminPassportKeyPair();
        const privateKey = await importPKCS8(privatePem, 'EdDSA');
        const issuedAt = Math.floor(Date.now() / 1000) - 600;
        const expiredToken = await new SignJWT({ email: 'dev@datagol.net' })
            .setProtectedHeader({ alg: 'EdDSA', kid: 'v1' })
            .setSubject('user-1')
            .setAudience(DEPLOYMENT_A)
            .setIssuer('api.datagol.net')
            .setJti('jti-expirado-test')
            .setIssuedAt(issuedAt)
            .setExpirationTime(issuedAt + 60)
            .sign(privateKey);

        const result = await verifyAdminPassport(expiredToken, DEPLOYMENT_A);
        expect(result).toEqual({ valid: false, reason: 'expirado' });
    });

    it('token con firma inválida (payload alterado sin resignar) se rechaza', async () => {
        const signed = await signAdminPassport({ sub: 'user-1', email: 'dev@datagol.net', deploymentId: DEPLOYMENT_A });
        const [headerB64, , sigB64] = signed.token.split('.');
        const tamperedPayload = Buffer.from(JSON.stringify({ email: 'atacante@example.com' })).toString('base64url');
        const tampered = `${headerB64}.${tamperedPayload}.${sigB64}`;
        const result = await verifyAdminPassport(tampered, DEPLOYMENT_A);
        expect(result.valid).toBe(false);
    });

    it('token firmado con una llave de otra versión (kid desconocido) se rechaza', async () => {
        const signed = await signAdminPassport({ sub: 'user-1', email: 'dev@datagol.net', deploymentId: DEPLOYMENT_A });
        const [headerB64, payloadB64, sigB64] = signed.token.split('.');
        const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
        header.kid = 'v99-nunca-existio';
        const tamperedHeaderB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
        const result = await verifyAdminPassport(`${tamperedHeaderB64}.${payloadB64}.${sigB64}`, DEPLOYMENT_A);
        expect(result).toEqual({ valid: false, reason: 'llave_desconocida' });
    });
});
