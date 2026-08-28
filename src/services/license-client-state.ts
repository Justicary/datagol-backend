import { FastifyInstance } from 'fastify';

/**
 * Fase B — estado local de la licencia de ESTA instalación, persistido en
 * `license_client_state` (migración 68, presente en toda instalación — a
 * diferencia de las tablas de `55_control_plane_datagol.sql`, que solo
 * existen en api.datagol.net).
 */
export interface LicenseClientStateRow {
    token: string | null;
    key_version: string | null;
    deployment_id: string | null;
    expires_at: string | null;
    last_verified_at: string | null;
    last_verification_ok: boolean;
    last_heartbeat_sent_at: string | null;
    last_heartbeat_ok: boolean;
    last_heartbeat_error: string | null;
    heartbeat_retry_count: number;
}

export async function readLicenseClientState(fastify: FastifyInstance): Promise<LicenseClientStateRow | null> {
    try {
        const { data, error } = await fastify.supabaseAdmin.from('license_client_state').select('*').eq('id', true).maybeSingle();

        if (error || !data) return null;
        return data as LicenseClientStateRow;
    } catch (err) {
        fastify.log.warn({ err }, '[LicenseClientState] No se pudo leer el estado local de licencia');
        return null;
    }
}

/**
 * Guarda un token recién recibido (emisión inicial en la provisión, o
 * renovación de un latido exitoso). `upsert` sobre la fila singleton
 * (`id = true`).
 */
export async function saveLicenseToken(
    fastify: FastifyInstance,
    params: { token: string; keyVersion: string; deploymentId: string; expiresAt: Date }
): Promise<void> {
    const { error } = await fastify.supabaseAdmin.from('license_client_state').upsert(
        {
            id: true,
            token: params.token,
            key_version: params.keyVersion,
            deployment_id: params.deploymentId,
            expires_at: params.expiresAt.toISOString(),
            last_verified_at: new Date().toISOString(),
            last_verification_ok: true,
        },
        { onConflict: 'id' }
    );

    if (error) {
        fastify.log.error({ err: error.message }, '[LicenseClientState] No se pudo guardar el token de licencia');
    }
}

export async function recordHeartbeatResult(
    fastify: FastifyInstance,
    ok: boolean,
    error: string | null,
    retryCount: number
): Promise<void> {
    const { error: dbError } = await fastify.supabaseAdmin.from('license_client_state').upsert(
        {
            id: true,
            last_heartbeat_sent_at: new Date().toISOString(),
            last_heartbeat_ok: ok,
            last_heartbeat_error: error,
            heartbeat_retry_count: retryCount,
        },
        { onConflict: 'id' }
    );

    if (dbError) {
        fastify.log.error({ err: dbError.message }, '[LicenseClientState] No se pudo registrar el resultado del latido');
    }
}
