import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveToolOrganization } from '../../lib/tool-auth.js';
import { withToolTimeout, ToolTimeoutError } from '../../lib/tool-timeout.js';
import { rescheduleBooking, CalCredentialsMissingError, CalProviderError } from '../../services/cal-com-tool-client.js';
import { toolParamsSchema, rescheduleBodySchema, rescheduleResponseSchema, isValidDateString } from '../../schemas/tool-routes.js';

const DEGRADED_MESSAGE = 'No puedo reprogramar la cita en este momento, ¿te llamo de vuelta?';
const NOT_FOUND_MESSAGE =
    'No encontré una cita a tu nombre con ese correo. ¿Podrías confirmarme el nombre completo y el correo con el que la agendaste?';
const NO_CAL_SYNC_MESSAGE = 'Encontré tu cita pero no puedo sincronizarla con el calendario en este momento. Te recomiendo contactar directamente al negocio.';

/**
 * POST /tools/:webhookToken/reschedule — Fase 5.2.
 * Verifica que la cita exista y pertenezca a quien llama, por nombre y
 * correo, antes de tocarla. Si no coincide, devuelve un mensaje claro que el
 * agente pueda verbalizar — nunca un fallo genérico.
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
            request.log.warn({ reason: auth.reason, route: 'reschedule', msg: 'Tool call rechazado' });
            return reply.status(401).send({ error: 'Unauthorized', message: auth.message });
        }

        const bodyResult = rescheduleBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Cuerpo de la petición inválido' });
        }
        const { customerName, customerEmail, newStartTime } = bodyResult.data;

        if (!isValidDateString(newStartTime)) {
            return reply.status(400).send({ error: 'BadRequest', message: 'newStartTime no es una fecha válida' });
        }

        // Dueño de la cita verificado por nombre + correo, nunca solo por un
        // ID que el LLM podría inventar o repetir de otra llamada.
        const { data: appointment, error: lookupError } = await fastify.supabaseAdmin
            .from('appointments')
            .select('id, cal_booking_id, start_time, end_time, customer_name, customer_email')
            .eq('organization_id', auth.organizationId)
            .ilike('customer_email', customerEmail.trim())
            .ilike('customer_name', customerName.trim())
            .neq('status', 'cancelled')
            .gt('start_time', new Date().toISOString())
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

            const { error: updateError } = await fastify.supabaseAdmin
                .from('appointments')
                .update({ start_time: calResult.startTime, end_time: calResult.endTime ?? fallbackEndTime, status: 'rescheduled' })
                .eq('id', appointment.id);

            if (updateError) {
                request.log.error({ organizationId: auth.organizationId, appointmentId: appointment.id, err: updateError.message, msg: 'Cal.com reprogramó pero falló la actualización en appointments' });
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
