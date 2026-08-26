import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuthenticatedUser } from '../lib/organization-auth.js';
import { getPermissionsForUser } from '../services/permission-service.js';
import { getOrganizationFeatures } from '../services/entitlements.js';
import { PERMISSION_KEYS } from '../types/permission-keys.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { APPOINTMENT_STATUSES } from '../types/appointment-status.js';
import { SEND_BULK_CONFIRMATION_REQUEST_QUEUE } from '../jobs/send-bulk-confirmation-request.js';
import { zonedDateTimeToUtc, DEFAULT_TIMEZONE } from '../services/reports/nl-dimensions.js';
import { orgIdParamsSchema } from '../schemas/contacts-crm.js';

const bulkConfirmBodySchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date debe tener formato YYYY-MM-DD'),
});

function forbiddenPermission(reply: FastifyReply, key: string) {
    return reply.status(403).send({
        success: false,
        error: `Permiso requerido: ${key}`,
    });
}

/**
 * `POST /api/organizations/:id/appointments/bulk-confirm` (docs/tasks/waitlist_confirmacion_masiva.md,
 * Tarea B4). Alcance v1 — decisión explícita del usuario: SOLO notificación.
 * Encola una solicitud de confirmación por cita elegible del día indicado;
 * no crea un mecanismo de aceptar/rechazar propio para `appointments` (eso
 * duplicaría el trabajo de `routes/public/waitlist-confirmation.ts` sobre
 * otra tabla). Si el cliente avisa que no asistirá, el negocio cancela la
 * cita desde el dashboard como ya hace hoy, lo cual dispara
 * `evaluate-waitlist-for-slot` (Tarea B3).
 */
export async function appointmentsAdminRoutes(fastify: FastifyInstance) {
    fastify.post('/api/organizations/:id/appointments/bulk-confirm', async (request, reply) => {
        const paramsResult = orgIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
        }
        const { id: organizationId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;

        const permissions = await getPermissionsForUser(organizationId, auth.userId, auth.jwt);
        if (!permissions.has(PERMISSION_KEYS.MANAGE_WAITLIST)) {
            return forbiddenPermission(reply, PERMISSION_KEYS.MANAGE_WAITLIST);
        }

        const features = await getOrganizationFeatures(organizationId);
        if (!features.has(FEATURE_KEYS.WAITLIST)) {
            return reply.status(403).send({
                success: false,
                error: `La función '${FEATURE_KEYS.WAITLIST}' no está habilitada para su organización.`,
                requiredFeature: FEATURE_KEYS.WAITLIST,
            });
        }

        const bodyResult = bulkConfirmBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: "date" debe tener formato YYYY-MM-DD.' });
        }
        const { date } = bodyResult.data;
        const [year, month, day] = date.split('-').map(Number);

        const scopedClient = fastify.supabaseUser(auth.jwt);
        const { data: org } = await scopedClient.from('organizations').select('timezone').eq('id', organizationId).maybeSingle();
        const timeZone = org?.timezone || DEFAULT_TIMEZONE;

        // Límites del día LOCAL de la organización, no medianoche UTC del
        // servidor (AGENTS.md §18: resolución de periodos en la zona horaria
        // de la organización).
        const dayStart = zonedDateTimeToUtc(year, month, day, 0, 0, 0, 0, timeZone);
        const dayEnd = zonedDateTimeToUtc(year, month, day, 23, 59, 59, 999, timeZone);

        const { data: appointments, error } = await scopedClient
            .from('appointments')
            .select('id')
            .eq('organization_id', organizationId)
            .in('status', [APPOINTMENT_STATUSES.PROGRAMADA, APPOINTMENT_STATUSES.CONFIRMADA])
            .is('confirmation_requested_at', null)
            .not('customer_phone', 'is', null)
            .gte('start_time', dayStart.toISOString())
            .lte('start_time', dayEnd.toISOString());

        if (error) {
            request.log.error({ organizationId, err: error.message, msg: 'Error consultando citas para confirmación masiva' });
            return reply.status(500).send({ success: false, error: 'No se pudieron consultar las citas de esa fecha.' });
        }

        for (const appointment of appointments ?? []) {
            await fastify.pgBoss.send(SEND_BULK_CONFIRMATION_REQUEST_QUEUE, { appointmentId: appointment.id });
        }

        return reply.send({ success: true, queued: appointments?.length ?? 0 });
    });
}

export default appointmentsAdminRoutes;
