import { describe, it, expect, beforeAll, vi } from 'vitest';
import { setTestLicenseKeyEnv } from './helpers/test-license-keys.js';
import { signLicenseToken, verifyLicenseToken, type LicenseTokenClaims } from '../src/lib/license-signing.js';

const baseClaims: LicenseTokenClaims = {
    deploymentId: '11111111-1111-1111-1111-111111111111',
    deploymentSlug: 'demo-clinica',
    planKey: 'pro',
    features: ['whatsapp', 'reportes'],
    fingerprint: 'fp-abc',
    warnAfterDays: 7,
    limitFeaturesAfterDays: 15,
    lockDashboardAfterDays: 30,
};

describe('src/lib/license-signing.ts', () => {
    beforeAll(async () => {
        await setTestLicenseKeyEnv('v1');
    });

    it('firma y verifica un token válido, preservando todos los claims', async () => {
        const signed = await signLicenseToken(baseClaims, 90);
        expect(signed.keyVersion).toBe('v1');

        const result = await verifyLicenseToken(signed.token);
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.result.claims).toEqual(baseClaims);
            expect(result.result.keyVersion).toBe('v1');
        }
    });

    it('contraparte de rechazo: sin token, reporta sin_token', async () => {
        const result = await verifyLicenseToken(null);
        expect(result).toEqual({ valid: false, reason: 'sin_token' });
    });

    it('contraparte de rechazo: cadena vacía se trata igual que ausencia de token', async () => {
        const result = await verifyLicenseToken('   ');
        expect(result).toEqual({ valid: false, reason: 'sin_token' });
    });

    it('contraparte de rechazo: token con formato inválido (no JWT) se rechaza', async () => {
        const result = await verifyLicenseToken('esto-no-es-un-jwt');
        expect(result.valid).toBe(false);
    });

    it('token expirado se rechaza con el motivo "expirado"', async () => {
        const signed = await signLicenseToken(baseClaims, -1); // ya vencido
        const result = await verifyLicenseToken(signed.token);
        expect(result).toEqual({ valid: false, reason: 'expirado' });
    });

    it('token firmado con una llave de OTRA versión (no presente en LICENSE_PUBLIC_KEYS) se rechaza', async () => {
        const signed = await signLicenseToken(baseClaims, 90, 'v1');

        // Se sustituye el `kid` del encabezado por una versión que el
        // verificador no conoce, sin resignar — simula un token cuya llave
        // pública nunca se distribuyó (rotación mal hecha).
        const [headerB64, payloadB64, sigB64] = signed.token.split('.');
        const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
        header.kid = 'v99-nunca-existio';
        const tamperedHeaderB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
        const tamperedToken = `${tamperedHeaderB64}.${payloadB64}.${sigB64}`;

        const result = await verifyLicenseToken(tamperedToken);
        expect(result).toEqual({ valid: false, reason: 'llave_desconocida' });
    });

    it('token con firma corrupta (payload alterado) se rechaza', async () => {
        const signed = await signLicenseToken(baseClaims, 90);
        const [headerB64, , sigB64] = signed.token.split('.');
        const tamperedPayload = Buffer.from(JSON.stringify({ ...baseClaims, planKey: 'enterprise' })).toString('base64url');
        const tamperedToken = `${headerB64}.${tamperedPayload}.${sigB64}`;

        const result = await verifyLicenseToken(tamperedToken);
        expect(result.valid).toBe(false);
    });

    it('sin LICENSE_PUBLIC_KEYS configuradas, cualquier verificación falla con llaves_publicas_no_configuradas', async () => {
        // config/env.ts cachea `validateEnv()` a nivel de módulo — las
        // pruebas anteriores ya lo poblaron con LICENSE_PUBLIC_KEYS presente.
        // Se resetea el registro de módulos de Vitest y se reimporta en
        // caliente para forzar una relectura real de process.env.
        const original = process.env.LICENSE_PUBLIC_KEYS;
        delete process.env.LICENSE_PUBLIC_KEYS;
        vi.resetModules();
        try {
            const fresh = await import('../src/lib/license-signing.js');
            const signed = await fresh.signLicenseToken(baseClaims, 90);
            const result = await fresh.verifyLicenseToken(signed.token);
            expect(result).toEqual({ valid: false, reason: 'llaves_publicas_no_configuradas' });
        } finally {
            process.env.LICENSE_PUBLIC_KEYS = original;
            vi.resetModules();
        }
    });
});
