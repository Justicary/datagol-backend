import { FastifyPluginAsync } from 'fastify';
import { supabaseAdmin } from '../../lib/supabase.js';
import { isPlatformAdmin } from '../../lib/platform-admin.js';

const CONFIRMATION_PHRASE = 'REINICIAR TODO';

interface FactoryResetBody {
    confirmation?: string;
    reason?: string;
}

/**
 * "Restaurar valores de fábrica" — vacía appointments/call_logs/contacts/
 * feature_audit_log/leads por completo (sin `organizationId`: no es un
 * borrado por tenant, es el reinicio de la instalación de un solo tenant,
 * AGENTS.md modelo DFY, para arrancar limpia con un cliente nuevo).
 *
 * `organizations`, `plans`, `features`, `organization_secrets`,
 * `usage_events` y `webhook_events` nunca se tocan — ver comentario de la
 * función `factory_reset_transactional_data()`
 * (db/migrations/23_factory_reset_function.sql) para el porqué (evitar el
 * CASCADE de TRUNCATE hacia usage_events).
 *
 * Doble candado: frase de confirmación exacta en el body (además de
 * cualquier confirmación en el frontend — nunca confiar solo en la UI para
 * una acción irreversible) + isPlatformAdmin. Como `feature_audit_log` es
 * una de las tablas que se vacía, esta acción no puede auditarse en la
 * propia base de datos sin contradecirse — se deja constancia en los logs
 * del servidor (Pino/Fastify), que sí sobreviven fuera de la tabla.
 */
export const adminFactoryResetRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', isPlatformAdmin);

    fastify.post<{ Body: FactoryResetBody }>('/api/admin/factory-reset', async (request, reply) => {
        const { confirmation, reason } = request.body || {};

        if (!reason || typeof reason !== 'string' || reason.trim() === '') {
            return reply.status(400).send({ error: 'BadRequest', message: 'El campo "reason" es obligatorio.' });
        }
        if (confirmation !== CONFIRMATION_PHRASE) {
            return reply.status(400).send({
                error: 'BadRequest',
                message: `El campo "confirmation" debe ser exactamente "${CONFIRMATION_PHRASE}".`,
            });
        }

        let adminIdentity = 'admin-bypass-local-dev';
        const authHeader = request.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
            const { data } = await supabaseAdmin.auth.getUser(authHeader.substring(7));
            adminIdentity = data.user?.email || data.user?.id || 'admin-token-sin-email';
        }

        // Único rastro que sobrevive a esta acción: feature_audit_log (una de
        // las tablas que se vacía) no puede registrarla sin contradecirse.
        request.log.warn({
            adminIdentity,
            reason: reason.trim(),
            msg: '🚨 FACTORY RESET — vaciando appointments/call_logs/contacts/feature_audit_log/leads',
        });

        const { data, error } = await supabaseAdmin.rpc('factory_reset_transactional_data');

        if (error) {
            request.log.error({ err: error, adminIdentity, msg: 'Error ejecutando factory_reset_transactional_data' });
            return reply.status(500).send({ error: 'InternalServerError', message: error.message });
        }

        request.log.warn({ adminIdentity, deleted: data, msg: '✅ FACTORY RESET completado' });

        return reply.status(200).send({
            message: 'Restauración de valores de fábrica completada.',
            deleted: data,
        });
    });
};

export default adminFactoryResetRoutes;
