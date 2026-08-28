import { FastifyPluginAsync } from 'fastify';
import { verifyLicenseToken } from '../../lib/license-signing.js';
import { rotateLicense, LicenseServiceError } from '../../services/license-service.js';
import { licenseHeartbeatPayloadSchema } from '../../services/license-heartbeat-payload.js';

/**
 * Fase B.2 — receptor del latido diario, exclusivo de api.datagol.net. A
 * diferencia del resto de `/control/**`, NO se protege con
 * `isPlatformAdmin`: quien llama es una instalación cliente, no un
 * administrador humano. Se autentica con su propio token de licencia
 * firmado (Bearer) — el mismo mecanismo que ya prueba que es una
 * instalación legítima.
 */
export const controlHeartbeatRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.post<{ Params: { id: string } }>('/control/deployments/:id/heartbeat', async (request, reply) => {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return reply.status(401).send({ error: 'Unauthorized', message: 'Se requiere el token de licencia vigente en Authorization: Bearer.' });
        }

        const presentedToken = authHeader.substring(7);
        const verification = await verifyLicenseToken(presentedToken);
        if (!verification.valid || verification.result.claims.deploymentId !== request.params.id) {
            return reply.status(401).send({ error: 'Unauthorized', message: 'Token de licencia inválido para este despliegue.' });
        }

        // La firma criptográfica sigue siendo válida hasta su expiración
        // natural aunque la licencia haya sido revocada en la base — la
        // revocación es un estado de la base, no del propio JWT. Sin esta
        // comprobación, una licencia revocada podría auto-renovarse por
        // latido y deshacer la revocación.
        const { data: license, error: licenseError } = await fastify.supabaseAdmin
            .from('licenses')
            .select('id, deployment_id')
            .eq('deployment_id', request.params.id)
            .is('revoked_at', null)
            .maybeSingle();

        if (licenseError || !license) {
            return reply.status(401).send({ error: 'Unauthorized', message: 'No hay una licencia activa para este despliegue.' });
        }

        const parseResult = licenseHeartbeatPayloadSchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({
                error: 'BadRequest',
                message: 'El payload del latido no cumple el esquema cerrado (posible campo no agregado o de datos personales).',
                details: parseResult.error.issues,
            });
        }
        const payload = parseResult.data;

        const { error: insertError } = await fastify.supabaseAdmin.from('license_heartbeats').insert({
            license_id: license.id,
            deployment_id: license.deployment_id,
            installed_version: payload.health.installedVersion,
            source_ip: request.ip,
            health: payload.health,
            metrics: {
                periodCounts: payload.periodCounts,
                usageUsdByProvider: payload.usageUsdByProvider,
                activeFeatures: payload.activeFeatures,
                seatsUsed: payload.seatsUsed,
                fingerprint: payload.fingerprint,
            },
        });

        if (insertError) {
            return reply.status(500).send({ error: 'InternalServerError', message: insertError.message });
        }

        await fastify.supabaseAdmin.from('licenses').update({ last_heartbeat_at: new Date().toISOString() }).eq('id', license.id);

        try {
            const { rawToken, license: renewed } = await rotateLicense(fastify, { licenseId: license.id });
            return reply.status(200).send({
                token: rawToken,
                keyVersion: renewed.key_version,
                expiresAt: renewed.expires_at,
            });
        } catch (err) {
            if (err instanceof LicenseServiceError) {
                return reply.status(err.statusCode).send({ error: err.name, message: err.message });
            }
            const message = err instanceof Error ? err.message : String(err);
            return reply.status(500).send({ error: 'InternalServerError', message });
        }
    });
};

export default controlHeartbeatRoutes;
