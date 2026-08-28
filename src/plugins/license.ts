import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { verifyLicenseToken } from '../lib/license-signing.js';
import { readLicenseClientState } from '../services/license-client-state.js';
import { resolveLicenseStage, type LicenseState } from '../lib/license-degradation.js';

const RECHECK_INTERVAL_MS = 60 * 60 * 1000; // Fase B.1: verificación local cada hora

/**
 * Fase B.1 — Cliente de licencia. Se registra en TODAS las instalaciones
 * (incluida api.datagol.net, que también corre su propia instancia
 * operativa). Verifica la firma ÚNICAMENTE con la llave pública local, sin
 * red — así si api.datagol.net está caído, esta misma instalación (si es
 * un cliente) sigue contestando llamadas sin degradarse por eso.
 *
 * REGLA DURA: nunca lanza, nunca impide que `buildApp()` termine de armar
 * la aplicación. Sin token válido, `fastify.license.status` queda en el
 * peor estado posible y el arranque continúa igual — "un contenedor que no
 * levanta por licencia es una llamada perdida".
 */
const licensePluginCallback: FastifyPluginAsync = async (fastify) => {
    async function refreshLicenseState(): Promise<void> {
        try {
            const row = await readLicenseClientState(fastify);
            const verification = await verifyLicenseToken(row?.token ?? null);

            let state: LicenseState;
            if (verification.valid) {
                const referenceDate = row?.last_heartbeat_ok && row?.last_heartbeat_sent_at
                    ? new Date(row.last_heartbeat_sent_at)
                    : verification.result.issuedAt;

                state = {
                    status: 'valida',
                    claims: verification.result.claims,
                    referenceDate,
                };
            } else if (verification.reason === 'expirado') {
                state = { status: 'expirada', claims: null, referenceDate: null };
            } else {
                state = { status: 'sin_token', claims: null, referenceDate: null };
            }

            fastify.license = state;
            if (verification.valid === false) {
                fastify.log.warn({ reason: verification.reason }, '[License] Verificación local de licencia no exitosa; la instalación continúa operando en modo degradado');
            }
        } catch (err) {
            // Ni siquiera un error inesperado aquí puede tumbar el arranque.
            fastify.log.error({ err }, '[License] Error inesperado verificando la licencia localmente; se asume estado degradado máximo');
            fastify.license = { status: 'sin_token', claims: null, referenceDate: null };
        }
    }

    fastify.decorate('license', { status: 'sin_token', claims: null, referenceDate: null } as LicenseState);
    await refreshLicenseState();

    const interval = setInterval(() => {
        void refreshLicenseState();
    }, RECHECK_INTERVAL_MS);
    interval.unref();

    fastify.addHook('onClose', async () => {
        clearInterval(interval);
    });

    fastify.addHook('onRequest', async (request: FastifyRequest) => {
        request.licenseStage = resolveLicenseStage(fastify.license);
    });
};

export const licensePlugin = fp(licensePluginCallback, {
    name: 'license-plugin',
    dependencies: ['supabase-plugin'],
});

export default licensePlugin;
