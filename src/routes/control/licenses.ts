import { FastifyPluginAsync } from 'fastify';
import { isPlatformAdmin } from '../../lib/platform-admin.js';
import { issueLicense, revokeLicense, rotateLicense, getLicense, LicenseServiceError } from '../../services/license-service.js';
import { issueLicenseBodySchema, revokeLicenseBodySchema, rotateLicenseBodySchema } from '../../schemas/control/license-schemas.js';

/**
 * Fase A.3 — exclusivo de api.datagol.net (CONTROL_PLANE=true). Todas las
 * rutas de este módulo solo se registran cuando la bandera está encendida
 * (Fase F, ver src/routes/control/index.ts).
 */
export const controlLicensesRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', isPlatformAdmin);

    fastify.post('/control/licenses', async (request, reply) => {
        const parseResult = issueLicenseBodySchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: parseResult.error.issues[0]?.message, details: parseResult.error.issues });
        }

        try {
            const { license, rawToken } = await issueLicense(fastify, {
                deploymentId: parseResult.data.deploymentId,
                validityDays: parseResult.data.validityDays,
                warnAfterDays: parseResult.data.warnAfterDays,
                limitFeaturesAfterDays: parseResult.data.limitFeaturesAfterDays,
                lockDashboardAfterDays: parseResult.data.lockDashboardAfterDays,
                fingerprint: parseResult.data.fingerprint,
                actorUserId: request.platformAdminUserId,
            });
            return reply.status(201).send({ data: { ...license, token: rawToken } });
        } catch (err) {
            return handleLicenseServiceError(err, reply);
        }
    });

    fastify.post<{ Params: { id: string } }>('/control/licenses/:id/revoke', async (request, reply) => {
        const parseResult = revokeLicenseBodySchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: parseResult.error.issues[0]?.message });
        }

        try {
            const license = await revokeLicense(fastify, {
                licenseId: request.params.id,
                reason: parseResult.data.reason,
                actorUserId: request.platformAdminUserId,
            });
            return reply.status(200).send({ data: license });
        } catch (err) {
            return handleLicenseServiceError(err, reply);
        }
    });

    fastify.post<{ Params: { id: string } }>('/control/licenses/:id/rotate', async (request, reply) => {
        const parseResult = rotateLicenseBodySchema.safeParse(request.body ?? {});
        if (!parseResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: parseResult.error.issues[0]?.message });
        }

        try {
            const { license, rawToken } = await rotateLicense(fastify, {
                licenseId: request.params.id,
                validityDays: parseResult.data.validityDays,
                actorUserId: request.platformAdminUserId,
            });
            return reply.status(200).send({ data: { ...license, token: rawToken } });
        } catch (err) {
            return handleLicenseServiceError(err, reply);
        }
    });

    fastify.get<{ Params: { id: string } }>('/control/licenses/:id', async (request, reply) => {
        try {
            const license = await getLicense(fastify, request.params.id);
            // El token firmado no se reexpone en un GET — ya se entregó una
            // sola vez en la emisión/rotación (mismo criterio que un secreto
            // de API: se muestra al crearse, no en cada consulta posterior).
            const { token: _token, ...withoutToken } = license;
            return reply.status(200).send({ data: withoutToken });
        } catch (err) {
            return handleLicenseServiceError(err, reply);
        }
    });
};

function handleLicenseServiceError(err: unknown, reply: any) {
    if (err instanceof LicenseServiceError) {
        return reply.status(err.statusCode).send({ error: err.name, message: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: 'InternalServerError', message });
}

export default controlLicensesRoutes;
