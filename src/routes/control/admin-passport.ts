import { FastifyPluginAsync } from 'fastify';
import { isPlatformAdmin } from '../../lib/platform-admin.js';
import { signAdminPassport } from '../../lib/admin-passport.js';
import { issueAdminPassportBodySchema } from '../../schemas/control/admin-passport-schemas.js';

/**
 * Fase SSO — exclusivo de api.datagol.net (CONTROL_PLANE=true). Emite el
 * pase que una instalación cliente verifica localmente para reconocer al
 * operador como superadmin en su propio `/admin`, sin depender de que su
 * proyecto Supabase comparta base con el plano de control.
 */
export const controlAdminPassportRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', isPlatformAdmin);

    fastify.post('/control/admin-passport', async (request, reply) => {
        const parseResult = issueAdminPassportBodySchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: parseResult.error.issues[0]?.message, details: parseResult.error.issues });
        }

        // El pase queda a nombre de un correo real — el atajo local
        // `x-platform-admin: true` (sin usuario real de Supabase Auth
        // detrás) no puede emitir uno, porque no hay a quién auditar.
        if (!request.platformAdminEmail) {
            return reply.status(400).send({
                error: 'BadRequest',
                message: 'No se pudo resolver un correo real para el operador — el pase no puede emitirse desde una sesión sin usuario de Supabase Auth.',
            });
        }

        const { data: deployment, error: deploymentError } = await fastify.supabaseAdmin
            .from('deployments')
            .select('id, slug, install_url, status')
            .eq('id', parseResult.data.deploymentId)
            .maybeSingle();

        if (deploymentError || !deployment) {
            return reply.status(404).send({ error: 'NotFound', message: `El despliegue '${parseResult.data.deploymentId}' no existe.` });
        }
        if (!deployment.install_url) {
            return reply.status(400).send({
                error: 'BadRequest',
                message: `El despliegue '${deployment.slug}' no tiene install_url configurada — no hay a dónde redirigir el pase.`,
            });
        }

        const signed = await signAdminPassport({
            sub: request.platformAdminUserId ?? request.platformAdminEmail,
            email: request.platformAdminEmail,
            deploymentId: deployment.id,
        });

        const { error: eventError } = await fastify.supabaseAdmin.from('deployment_events').insert({
            deployment_id: deployment.id,
            event_type: 'pase_admin_emitido',
            description: `Pase de superadmin emitido para ${request.platformAdminEmail}`,
            actor_user_id: request.platformAdminUserId ?? null,
            metadata: { jti: signed.jti, expiresAt: signed.expiresAt.toISOString() },
        });
        if (eventError) {
            request.log.error({ err: eventError.message, deploymentId: deployment.id }, '[AdminPassport] No se pudo registrar el evento de auditoría');
        }

        const callbackUrl = `${deployment.install_url.replace(/\/$/, '')}/admin/sso/callback?passport=${encodeURIComponent(signed.token)}`;

        return reply.status(200).send({
            data: {
                callbackUrl,
                deploymentSlug: deployment.slug,
                expiresAt: signed.expiresAt,
            },
        });
    });
};

export default controlAdminPassportRoutes;
