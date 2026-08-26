import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveToolOrganization } from '../../lib/tool-auth.js';
import { withToolTimeout, ToolTimeoutError } from '../../lib/tool-timeout.js';
import { cancelBooking, CalCredentialsMissingError, CalProviderError } from '../../services/cal-com-tool-client.js';
import { normalizePhoneE164 } from '../../services/phone-normalization.js';
import { toolParamsSchema, cancelBodySchema, cancelResponseSchema } from '../../schemas/tool-routes.js';
import { APPOINTMENT_STATUSES } from '../../types/appointment-status.js';
import { EVALUATE_WAITLIST_FOR_SLOT_QUEUE } from '../../jobs/evaluate-waitlist-for-slot.js';

const DEGRADED_MESSAGE = 'No puedo cancelar la cita en este momento, ¿te llamo de vuelta?';
const NOT_FOUND_MESSAGE =
    'No encontré una cita a tu nombre con esos datos. ¿Podrías confirmarme el nombre completo y el teléfono o correo con el que la agendaste?';
const MISSING_CONTACT_MESSAGE = 'Para buscar tu cita necesito al menos tu número de teléfono o tu correo electrónico, ¿me compartes uno de los dos?';

/**
 * POST /tools/:webhookToken/cancel — Cancelación de cita por solicitud del
 * cliente durante la llamada de voz. Verifica que la cita exista y pertenezca
 * a quien llama (nombre + correo y/o teléfono) antes de tocarla.
 *
 * La cancelación en Cal.com es best-effort: si Cal.com falla, la cita se
 * marca cancelada localmente de todas formas (priorizar la experiencia del
 * usuario — si el cliente quiere cancelar, se cancela) y se registra un
 * warning para reconciliar manualmente si es necesario.
 */
export async function cancelToolRoute(fastify: FastifyInstance) {
    fastify.post('/tools/:webhookToken/cancel', async (request: FastifyRequest, reply: FastifyReply) => {
        const paramsResult = toolParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'webhookToken inválido en la ruta' });
        }

        const secretHeader = request.headers['x-tool-secret'] as string | undefined;
        const auth = await resolveToolOrganization(fastify, paramsResult.data.webhookToken, secretHeader);
        if (!auth.ok) {
            const statusCode = auth.reason === 'suspended' ? 403 : 401;
            request.log.warn({ reason: auth.reason, route: 'cancel', msg: 'Tool call rechazado' });
            return reply.status(statusCode).send({
                error: statusCode === 403 ? 'Forbidden' : 'Unauthorized',
                message: auth.message,
            });
        }

        const bodyResult = cancelBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Cuerpo de la petición inválido' });
        }
        const { customerName, customerEmail, customerPhone, reason } = bodyResult.data;

        // Cancelar exige alguno de los dos para poder ubicar la cita con
        // seguridad — nunca solo por nombre (puede haber homónimos).
        if (!customerEmail && !customerPhone) {
            return reply.status(200).send(cancelResponseSchema.parse({ cancelled: false, message: MISSING_CONTACT_MESSAGE }));
        }

        // Dueño de la cita verificado por nombre + (correo y/o teléfono),
        // nunca solo por un ID que el LLM podría inventar o repetir de otra
        // llamada. Mismo patrón que reschedule.ts.
        let appointmentQuery = fastify.supabaseAdmin
            .from('appointments')
            .select('id, cal_booking_id, customer_name, customer_email, start_time, end_time')
            .eq('organization_id', auth.organizationId)
            .ilike('customer_name', customerName.trim())
            .neq('status', APPOINTMENT_STATUSES.CANCELADA)
            .gt('start_time', new Date().toISOString());

        if (customerEmail) {
            appointmentQuery = appointmentQuery.ilike('customer_email', customerEmail.trim());
        }
        if (customerPhone) {
            const normalizedPhone = normalizePhoneE164(customerPhone);
            appointmentQuery = appointmentQuery.eq('customer_phone', normalizedPhone.success ? normalizedPhone.phoneE164 : customerPhone.trim());
        }

        const { data: appointment, error: lookupError } = await appointmentQuery
            .order('start_time', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (lookupError) {
            request.log.error({ organizationId: auth.organizationId, err: lookupError.message, msg: 'Error consultando appointments para cancel' });
            return reply.status(200).send(cancelResponseSchema.parse({ cancelled: false, message: DEGRADED_MESSAGE }));
        }

        if (!appointment) {
            return reply.status(200).send(cancelResponseSchema.parse({ cancelled: false, message: NOT_FOUND_MESSAGE }));
        }

        // Best-effort: cancelar en Cal.com primero. Si falla, se cancela
        // localmente de todas formas — el cliente quiere cancelar, no se le
        // va a decir que no por un error del proveedor de calendario.
        if (appointment.cal_booking_id) {
            try {
                await withToolTimeout((signal) =>
                    cancelBooking(
                        fastify,
                        auth.organizationId,
                        appointment.cal_booking_id as string,
                        reason ?? `Cancelado por ${customerName} durante llamada de voz`,
                        signal
                    )
                );
            } catch (err) {
                // Se registra pero no se aborta la cancelación local.
                logDegradedFailure(request, auth.organizationId, err);
            }
        }

        const { error: updateError } = await fastify.supabaseAdmin
            .from('appointments')
            .update({ status: APPOINTMENT_STATUSES.CANCELADA })
            .eq('id', appointment.id)
            // Evita pisar un cambio concurrente (un admin ya la modificó
            // mientras el agente hablaba).
            .neq('status', APPOINTMENT_STATUSES.CANCELADA);

        if (updateError) {
            request.log.error({ organizationId: auth.organizationId, appointmentId: appointment.id, err: updateError.message, msg: 'Error actualizando status a cancelada en appointments' });
            return reply.status(200).send(cancelResponseSchema.parse({ cancelled: false, message: DEGRADED_MESSAGE }));
        }

        // Tarea B3 (docs/tasks/waitlist_confirmacion_masiva.md): mismo
        // disparo que la cancelación desde dashboard (contacts-crm.ts).
        // Best-effort y fuera del presupuesto de latencia del tool solo en
        // caso de fallo — un pgBoss.send exitoso es una inserción rápida.
        try {
            await fastify.pgBoss.send(EVALUATE_WAITLIST_FOR_SLOT_QUEUE, {
                organizationId: auth.organizationId,
                slotStartTime: appointment.start_time,
                slotEndTime: appointment.end_time,
            });
        } catch (err) {
            request.log.warn(
                { organizationId: auth.organizationId, appointmentId: appointment.id, err: err instanceof Error ? err.message : String(err), msg: 'No se pudo encolar evaluate-waitlist-for-slot tras cancelar por voz' }
            );
        }

        return reply.status(200).send(
            cancelResponseSchema.parse({
                cancelled: true,
                message: 'Tu cita ha sido cancelada correctamente.',
            })
        );
    });
}

function logDegradedFailure(request: FastifyRequest, organizationId: string, err: unknown): void {
    const errName = err instanceof Error ? err.name : 'UnknownError';
    const errMessage = err instanceof Error ? err.message : String(err);

    if (err instanceof CalCredentialsMissingError) {
        request.log.error({ organizationId, msg: 'Tool degradado: cal_api_key no configurado para cancelar en Cal.com' });
    } else if (err instanceof ToolTimeoutError) {
        request.log.warn({ organizationId, msg: 'Tool degradado: timeout cancelando en Cal.com' });
    } else if (err instanceof CalProviderError) {
        request.log.warn({ organizationId, status: err.status, msg: 'Tool degradado: Cal.com respondió error al cancelar' });
    } else {
        request.log.error({ organizationId, errName, errMessage, msg: 'Tool degradado: error inesperado al cancelar en Cal.com' });
    }
}

export default cancelToolRoute;
