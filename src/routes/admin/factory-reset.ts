import { FastifyPluginAsync } from 'fastify';
import { supabaseAdmin } from '../../lib/supabase.js';
import { isPlatformAdmin } from '../../lib/platform-admin.js';
import { collectReportStoragePaths, removeReportFiles } from '../../services/factory-reset-service.js';

const CONFIRMATION_PHRASE = 'REINICIAR TODO';

interface FactoryResetBody {
    confirmation?: string;
    reason?: string;
}

/**
 * "Restaurar valores de fábrica" — vacía por completo los datos
 * transaccionales y de pruebas de la instalación (sin `organizationId`: no es
 * un borrado por tenant, es el reinicio de la instalación de un solo tenant,
 * AGENTS.md modelo DFY, para arrancar limpia con un cliente nuevo). La lista
 * exacta de tablas y lo que se conserva está en
 * db/migrations/74_factory_reset_extended.sql.
 *
 * Nunca se tocan configuración, infraestructura ni facturación:
 * `organizations`, `credential_groups`, `organization_secrets`, `plans`,
 * `features`, `usage_events` (solo se limpia `call_log_id` colgante),
 * `webhook_events`, miembros, permisos, buzones, catálogos y las direcciones
 * de la propia organización.
 *
 * Los archivos de reportes semanales en Storage se borran aquí, DESPUÉS de
 * la función SQL (Storage no participa de la transacción): ver
 * services/factory-reset-service.ts.
 *
 * Doble candado: frase de confirmación exacta en el body (además de
 * cualquier confirmación en el frontend — nunca confiar solo en la UI para
 * una acción irreversible) + isPlatformAdmin. Como `feature_audit_log` y
 * `permission_audit_log` se vacían, esta acción no puede auditarse en la
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

        // Único rastro que sobrevive a esta acción: las bitácoras de auditoría
        // (que se vacían) no pueden registrarla sin contradecirse.
        request.log.warn({
            adminIdentity,
            reason: reason.trim(),
            msg: '🚨 FACTORY RESET — vaciando datos transaccionales y de pruebas (migración 74)',
        });

        // Rutas de Storage ANTES de borrar las filas que las contienen.
        let reportPaths: string[];
        try {
            reportPaths = await collectReportStoragePaths(supabaseAdmin);
        } catch (err) {
            request.log.error({ err, adminIdentity, msg: 'Factory reset abortado: no se pudieron leer las rutas de reportes' });
            return reply.status(500).send({ error: 'InternalServerError', message: 'No se pudieron leer los archivos de reportes; no se borró nada.' });
        }

        const { data, error } = await supabaseAdmin.rpc('factory_reset_transactional_data');

        if (error) {
            request.log.error({ err: error, adminIdentity, msg: 'Error ejecutando factory_reset_transactional_data' });
            return reply.status(500).send({ error: 'InternalServerError', message: error.message });
        }

        const storage = await removeReportFiles(supabaseAdmin, reportPaths);
        if (storage.failed > 0) {
            request.log.error({
                adminIdentity,
                failed: storage.failed,
                errors: storage.errors,
                msg: 'Factory reset: filas borradas, pero quedaron archivos de reportes huérfanos en Storage',
            });
        }

        request.log.warn({ adminIdentity, deleted: data, storage, msg: '✅ FACTORY RESET completado' });

        return reply.status(200).send({
            message: 'Restauración de valores de fábrica completada.',
            deleted: data,
            storage: { reportFilesRemoved: storage.removed, reportFilesFailed: storage.failed },
        });
    });
};

export default adminFactoryResetRoutes;
