import { FastifyInstance } from 'fastify';
import { validateEnv } from '../config/env.js';
import { verifyLicenseToken } from '../lib/license-signing.js';
import { buildLicenseHeartbeatPayload } from '../services/license-heartbeat-payload.js';
import { readLicenseClientState, saveLicenseToken, recordHeartbeatResult } from '../services/license-client-state.js';

export const SEND_LICENSE_HEARTBEAT_QUEUE = 'send-license-heartbeat';

const HEARTBEAT_TIMEOUT_MS = 10_000;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Fase B.2 — se ejecuta a diario en TODA instalación (incluida la propia
 * instancia operativa de Datagol). Nunca lanza más allá de dejar que
 * pg-boss reintente con retroceso exponencial (`retryBackoff: true` en el
 * registro más abajo) — un latido que falla nunca bloquea nada del camino
 * de voz, solo deja constancia en `license_client_state` para que el
 * dashboard lo muestre.
 */
export async function sendLicenseHeartbeatHandler(fastify: FastifyInstance): Promise<void> {
    const state = await readLicenseClientState(fastify);
    if (!state?.deployment_id || !state.token) {
        fastify.log.info('[LicenseHeartbeat] Sin token de licencia local; se omite el latido (la atención de voz no depende de esto).');
        return;
    }

    const env = validateEnv();
    if (!env.CONTROL_PLANE_URL) {
        fastify.log.info('[LicenseHeartbeat] CONTROL_PLANE_URL no configurada; se omite el envío del latido.');
        return;
    }

    const verification = await verifyLicenseToken(state.token);
    const activeFeatures = verification.valid ? verification.result.claims.features : [];
    const fingerprint = verification.valid ? verification.result.claims.fingerprint : null;

    const since = state.last_heartbeat_sent_at ? new Date(state.last_heartbeat_sent_at) : new Date(Date.now() - DEFAULT_LOOKBACK_MS);
    const payload = await buildLicenseHeartbeatPayload(fastify, since, activeFeatures, fingerprint);

    try {
        const response = await fetch(`${env.CONTROL_PLANE_URL}/control/deployments/${state.deployment_id}/heartbeat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${state.token}`,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`El plano de control respondió ${response.status}: ${text.slice(0, 200)}`);
        }

        const body = (await response.json()) as { token: string; keyVersion: string; expiresAt: string };
        await saveLicenseToken(fastify, {
            token: body.token,
            keyVersion: body.keyVersion,
            deploymentId: state.deployment_id,
            expiresAt: new Date(body.expiresAt),
        });
        await recordHeartbeatResult(fastify, true, null, 0);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await recordHeartbeatResult(fastify, false, message, (state.heartbeat_retry_count ?? 0) + 1);
        fastify.log.warn({ err: message }, '[LicenseHeartbeat] Falló el envío del latido; pg-boss reintentará con retroceso exponencial');
        throw err;
    }
}

export async function registerSendLicenseHeartbeatWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(SEND_LICENSE_HEARTBEAT_QUEUE, { retryLimit: 5, retryBackoff: true });

    await fastify.pgBoss.work(SEND_LICENSE_HEARTBEAT_QUEUE, async () => {
        await sendLicenseHeartbeatHandler(fastify);
    });

    await fastify.pgBoss.schedule(SEND_LICENSE_HEARTBEAT_QUEUE, '0 6 * * *', null, { tz: 'UTC' });
}
