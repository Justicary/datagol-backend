import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveToolOrganization } from '../../lib/tool-auth.js';
import { withToolTimeout, ToolTimeoutError } from '../../lib/tool-timeout.js';
import { rescheduleBooking, CalCredentialsMissingError, CalProviderError } from '../../services/cal-com-tool-client.js';
import { normalizePhoneE164 } from '../../services/phone-normalization.js';
import { toolParamsSchema, rescheduleBodySchema, rescheduleResponseSchema, isValidDateString } from '../../schemas/tool-routes.js';
import { APPOINTMENT_STATUSES } from '../../types/appointment-status.js';

const DEGRADED_MESSAGE = 'No puedo reprogramar la cita en este momento, ¿te llamo de vuelta?';
const NOT_FOUND_MESSAGE =
    'No encontré una cita a tu nombre con esos datos. ¿Podrías confirmarme el nombre completo y el teléfono o correo con el que la agendaste?';
const MISSING_CONTACT_MESSAGE = 'Para buscar tu cita necesito al menos tu número de teléfono o tu correo electrónico, ¿me compartes uno de los dos?';
const NO_CAL_SYNC_MESSAGE = 'Encontré tu cita pero no puedo sincronizarla con el calendario en este momento. Te recomiendo contactar directamente al negocio.';

/**
 * POST /tools/:webhookToken/reschedule — Fase 5.2.
 * Verifica que la cita exista y pertenezca a quien llama, por nombre y
 * correo y/o teléfono, antes de tocarla. Si no coincide, devuelve un mensaje
 * claro que el agente pueda verbalizar — nunca un fallo genérico.
 */
export async function rescheduleToolRoute(fastify: FastifyInstance) {
    fastify.post('/tools/:webhookToken/reschedule', async (request: FastifyRequest, reply: FastifyReply) => {
        const paramsResult = toolParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'webhookToken inválido en la ruta' });
        }

        const secretHeader = request.headers['x-tool-secret'] as string | undefined;
        const auth = await resolveToolOrganization(fastify, paramsResult.data.webhookToken, secretHeader);
        if (!auth.ok) {
            const statusCode = auth.reason === 'suspended' ? 403 : 401;
            request.log.warn({ reason: auth.reason, route: 'reschedule', msg: 'Tool call rechazado' });
            return reply.status(statusCode).send({
                error: statusCode === 403 ? 'Forbidden' : 'Unauthorized',
                message: auth.message,
            });
        }

        const bodyResult = rescheduleBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Cuerpo de la petición inválido' });
        }
        const { customerName, customerEmail, customerPhone, newStartTime } = bodyResult.data;

        if (!isValidDateString(newStartTime)) {
            return reply.status(400).send({ error: 'BadRequest', message: 'newStartTime no es una fecha válida' });
        }

        // La cita original pudo haberse agendado solo con teléfono (canal web
        // chat sin correo) o solo con correo — pero reprogramar exige alguno
        // de los dos para poder ubicarla con seguridad.
        if (!customerEmail && !customerPhone) {
            return reply.status(200).send(rescheduleResponseSchema.parse({ rescheduled: false, message: MISSING_CONTACT_MESSAGE }));
        }

        // Dueño de la cita verificado por nombre + (correo y/o teléfono),
        // nunca solo por un ID que el LLM podría inventar o repetir de otra
        // llamada. Si se da un solo identificador, se filtra solo por ese;
        // si se dan ambos, deben coincidir los dos.
        let appointmentQuery = fastify.supabaseAdmin
            .from('appointments')
            .select('id, organization_id, contact_id, contact_address_id, customer_name, customer_email, customer_phone, service_address, latitude, longitude, call_log_id, cal_booking_id, start_time, end_time')
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
            request.log.error({ organizationId: auth.organizationId, err: lookupError.message, msg: 'Error consultando appointments para reschedule' });
            return reply.status(200).send(rescheduleResponseSchema.parse({ rescheduled: false, message: DEGRADED_MESSAGE }));
        }

        if (!appointment) {
            return reply.status(200).send(rescheduleResponseSchema.parse({ rescheduled: false, message: NOT_FOUND_MESSAGE }));
        }

        if (!appointment.cal_booking_id) {
            request.log.warn({ organizationId: auth.organizationId, appointmentId: appointment.id, msg: 'Cita sin cal_booking_id, no se puede reprogramar en Cal.com' });
            return reply.status(200).send(rescheduleResponseSchema.parse({ rescheduled: false, message: NO_CAL_SYNC_MESSAGE }));
        }

        try {
            const calResult = await withToolTimeout((signal) =>
                rescheduleBooking(
                    fastify,
                    auth.organizationId,
                    { calBookingId: appointment.cal_booking_id as string, newStartTime, reason: `Reprogramado por ${customerName} durante llamada de voz` },
                    signal
                )
            );

            // appointments.end_time es NOT NULL; si Cal.com no devuelve `end`
            // en la respuesta de reschedule, se preserva la duración original
            // de la cita en vez de asumir un valor arbitrario.
            const originalDurationMs = new Date(appointment.end_time).getTime() - new Date(appointment.start_time).getTime();
            const fallbackEndTime = new Date(new Date(calResult.startTime).getTime() + originalDurationMs).toISOString();

            // 1. Marcar la cita original como cancelada para conservar el historial
            // de la fecha y UID previo en Cal.com.
            const { error: cancelError } = await fastify.supabaseAdmin
                .from('appointments')
                .update({
                    status: APPOINTMENT_STATUSES.CANCELADA,
                    status_updated_at: new Date().toISOString(),
                })
                .eq('id', appointment.id);

            if (cancelError) {
                request.log.warn({ organizationId: auth.organizationId, appointmentId: appointment.id, err: cancelError.message, msg: 'Error actualizando cita original a cancelada durante reprogramación' });
            }

            // 2. Insertar nuevo registro con el nuevo UID de Cal.com y estado 'reprogramada'
            const { error: insertError } = await fastify.supabaseAdmin
                .from('appointments')
                .insert({
                    organization_id: auth.organizationId,
                    contact_id: appointment.contact_id ?? null,
                    contact_address_id: appointment.contact_address_id ?? null,
                    customer_name: appointment.customer_name,
                    customer_email: appointment.customer_email ?? null,
                    customer_phone: appointment.customer_phone ?? null,
                    service_address: appointment.service_address ?? null,
                    latitude: appointment.latitude ?? null,
                    longitude: appointment.longitude ?? null,
                    call_log_id: appointment.call_log_id ?? null,
                    conversation_id: null,
                    start_time: calResult.startTime,
                    end_time: calResult.endTime ?? fallbackEndTime,
                    cal_booking_id: calResult.calBookingId,
                    status: APPOINTMENT_STATUSES.REPROGRAMADA,
                });

            if (insertError) {
                request.log.error({ organizationId: auth.organizationId, appointmentId: appointment.id, err: insertError.message, msg: 'Cal.com reprogramó pero falló la inserción de la nueva cita en appointments' });
                return reply.status(200).send(rescheduleResponseSchema.parse({ rescheduled: false, message: DEGRADED_MESSAGE }));
            }

            return reply.status(200).send(
                rescheduleResponseSchema.parse({
                    rescheduled: true,
                    message: `Tu cita fue reprogramada para ${calResult.startTime}.`,
                    newStartTime: calResult.startTime,
                })
            );
        } catch (err) {
            logDegradedFailure(request, auth.organizationId, err);
            return reply.status(200).send(rescheduleResponseSchema.parse({ rescheduled: false, message: DEGRADED_MESSAGE }));
        }
    });
}

function logDegradedFailure(request: FastifyRequest, organizationId: string, err: unknown): void {
    const errName = err instanceof Error ? err.name : 'UnknownError';
    const errMessage = err instanceof Error ? err.message : String(err);

    if (err instanceof CalCredentialsMissingError) {
        request.log.error({ organizationId, msg: 'Tool degradado: cal_api_key no configurado' });
    } else if (err instanceof ToolTimeoutError) {
        request.log.warn({ organizationId, msg: 'Tool degradado: timeout reprogramando en Cal.com' });
    } else if (err instanceof CalProviderError) {
        request.log.warn({ organizationId, status: err.status, msg: 'Tool degradado: Cal.com respondió error' });
    } else {
        request.log.error({ organizationId, errName, errMessage, msg: 'Tool degradado: error inesperado' });
    }
}

export default rescheduleToolRoute;
