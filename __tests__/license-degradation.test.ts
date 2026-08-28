import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { resolveLicenseStage, requireLicenseStageAtMost, type LicenseState } from '../src/lib/license-degradation.js';
import type { LicenseTokenClaims } from '../src/lib/license-signing.js';

const claims: LicenseTokenClaims = {
    deploymentId: 'd1',
    deploymentSlug: 'demo',
    planKey: 'pro',
    features: [],
    fingerprint: null,
    warnAfterDays: 7,
    limitFeaturesAfterDays: 15,
    lockDashboardAfterDays: 30,
};

function daysAgo(n: number): Date {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

describe('src/lib/license-degradation.ts — resolveLicenseStage', () => {
    it('licencia válida y con latido reciente: etapa normal', () => {
        const state: LicenseState = { status: 'valida', claims, referenceDate: daysAgo(1) };
        expect(resolveLicenseStage(state)).toBe('normal');
    });

    it('exactamente en el umbral de warnAfterDays: etapa aviso (límite inclusivo)', () => {
        const state: LicenseState = { status: 'valida', claims, referenceDate: daysAgo(7) };
        expect(resolveLicenseStage(state)).toBe('aviso');
    });

    it('un día antes del umbral de aviso: sigue en normal (contraparte del límite)', () => {
        const state: LicenseState = { status: 'valida', claims, referenceDate: daysAgo(6) };
        expect(resolveLicenseStage(state)).toBe('normal');
    });

    it('entre 15 y 30 días sin latido: features_limitadas', () => {
        const state: LicenseState = { status: 'valida', claims, referenceDate: daysAgo(20) };
        expect(resolveLicenseStage(state)).toBe('features_limitadas');
    });

    it('30 días o más sin latido: dashboard_bloqueado', () => {
        const state: LicenseState = { status: 'valida', claims, referenceDate: daysAgo(45) };
        expect(resolveLicenseStage(state)).toBe('dashboard_bloqueado');
    });

    it('licencia expirada: siempre dashboard_bloqueado, sin importar referenceDate', () => {
        const state: LicenseState = { status: 'expirada', claims: null, referenceDate: null };
        expect(resolveLicenseStage(state)).toBe('dashboard_bloqueado');
    });

    it('licencia revocada: siempre dashboard_bloqueado', () => {
        const state: LicenseState = { status: 'revocada', claims: null, referenceDate: null };
        expect(resolveLicenseStage(state)).toBe('dashboard_bloqueado');
    });

    it('sin token: siempre dashboard_bloqueado', () => {
        const state: LicenseState = { status: 'sin_token', claims: null, referenceDate: null };
        expect(resolveLicenseStage(state)).toBe('dashboard_bloqueado');
    });

    it('umbrales personalizados del token (no hardcodeados): un warnAfterDays de 1 día degrada mucho antes', () => {
        const customClaims: LicenseTokenClaims = { ...claims, warnAfterDays: 1, limitFeaturesAfterDays: 2, lockDashboardAfterDays: 3 };
        const state: LicenseState = { status: 'valida', claims: customClaims, referenceDate: daysAgo(2) };
        expect(resolveLicenseStage(state)).toBe('features_limitadas');
    });
});

describe('src/lib/license-degradation.ts — requireLicenseStageAtMost (prueba central)', () => {
    async function buildProbeApp(licenseStage: LicenseState['status'], referenceDaysAgo: number | null) {
        const app = Fastify({ logger: false });
        app.addHook('onRequest', async (request) => {
            const state: LicenseState = {
                status: licenseStage,
                claims: licenseStage === 'valida' ? claims : null,
                referenceDate: referenceDaysAgo === null ? null : daysAgo(referenceDaysAgo),
            };
            request.licenseStage = resolveLicenseStage(state);
        });
        // routes/tools/** NUNCA registra este preHandler — se simula aquí solo
        // para la ruta administrativa de prueba, nunca la de voz.
        app.get('/api/organizations/reports', { preHandler: [requireLicenseStageAtMost('normal')] }, async (_req, reply) =>
            reply.send({ ok: true })
        );
        app.get('/api/tools/booking', async (_req, reply) => reply.send({ ok: true, voice: true }));
        await app.ready();
        return app;
    }

    it('contraparte de éxito: en etapa normal, la ruta de reportes responde 200', async () => {
        const app = await buildProbeApp('valida', 1);
        const res = await app.inject({ method: 'GET', url: '/api/organizations/reports' });
        expect(res.statusCode).toBe(200);
        await app.close();
    });

    it('en features_limitadas, la ruta de reportes se rechaza con 403 y motivo LICENSE_DEGRADED', async () => {
        const app = await buildProbeApp('valida', 20);
        const res = await app.inject({ method: 'GET', url: '/api/organizations/reports' });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('LICENSE_DEGRADED');
        await app.close();
    });

    it('PRUEBA CENTRAL: licencia expirada, revocada y 60 días sin latido → routes/tools/** (voz) sigue respondiendo 200', async () => {
        const app = await buildProbeApp('revocada', null);
        const toolsRes = await app.inject({ method: 'GET', url: '/api/tools/booking' });
        expect(toolsRes.statusCode).toBe(200);
        expect(toolsRes.json()).toEqual({ ok: true, voice: true });

        // La misma degradación máxima SÍ bloquea la ruta administrativa —
        // confirma que el aislamiento es real, no que el gate simplemente no hace nada.
        const reportsRes = await app.inject({ method: 'GET', url: '/api/organizations/reports' });
        expect(reportsRes.statusCode).toBe(403);
        await app.close();
    });
});
