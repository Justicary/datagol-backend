import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isPlatformAdmin } from '../../lib/platform-admin.js';
import { verifyAdminPassport } from '../../lib/admin-passport.js';
import { signAdminSession } from '../../lib/admin-session.js';
import { validateEnv } from '../../config/env.js';

const exchangePassportBodySchema = z
    .object({
        passport: z.string().min(1, 'passport es obligatorio.'),
    })
    .strict();

/**
 * Pasaporte de superadmin — SSO delegado a api.datagol.net. En TODA
 * instalación (a diferencia de `/control/**`, exclusivo del plano de
 * control): cualquier instalación cliente debe poder recibir y canjear un
 * pase, o el operador no tendría cómo entrar a `/admin` ahí.
 */
export const adminSsoRoutes: FastifyPluginAsync = async (fastify) => {
    /**
     * POST /api/admin/sso/exchange — canjea un pase firmado por
     * api.datagol.net por una sesión local. Deliberadamente SIN
     * `isPlatformAdmin`: es precisamente el mecanismo para obtenerla; su
     * propia autorización es la firma verificable del pase.
     */
    fastify.post('/api/admin/sso/exchange', async (request, reply) => {
        const parseResult = exchangePassportBodySchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: parseResult.error.issues[0]?.message });
        }

        const env = validateEnv();
        if (!env.DEPLOYMENT_ID) {
            return reply.status(500).send({
                error: 'InternalServerError',
                message: 'Esta instalación no tiene DEPLOYMENT_ID configurado; no puede aceptar pases de superadmin.',
            });
        }
        if (!env.ADMIN_SESSION_SECRET) {
            return reply.status(500).send({
                error: 'InternalServerError',
                message: 'Esta instalación no tiene ADMIN_SESSION_SECRET configurado; no puede emitir sesiones locales.',
            });
        }

        const result = await verifyAdminPassport(parseResult.data.passport, env.DEPLOYMENT_ID);
        if (!result.valid) {
            request.log.warn({ reason: result.reason }, '[AdminSso] Pase de superadmin rechazado');
            return reply.status(401).send({ error: 'Unauthorized', message: 'Pase de superadmin inválido, expirado, ya usado, o emitido para otro despliegue.' });
        }

        const session = await signAdminSession(result.claims.email);
        request.log.info({ email: result.claims.email }, '[AdminSso] Sesión local de superadmin emitida vía pase');

        return reply.status(200).send({
            data: {
                sessionToken: session.token,
                expiresAt: session.expiresAt,
            },
        });
    });

    /**
     * GET /api/admin/sso/whoami — chequeo liviano que `AdminLayout`
     * (mi-new-app) usa para confirmar si la cookie local sigue siendo una
     * sesión de superadmin válida, sin duplicar la verificación de
     * `isPlatformAdmin` en el frontend.
     */
    fastify.get('/api/admin/sso/whoami', { preHandler: isPlatformAdmin }, async (request, reply) => {
        return reply.status(200).send({ data: { email: request.platformAdminEmail ?? null } });
    });
};

export default adminSsoRoutes;
