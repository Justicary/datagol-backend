import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveToolOrganization } from '../../lib/tool-auth.js';
import { withToolTimeout, ToolTimeoutError } from '../../lib/tool-timeout.js';
import { createBooking, CalCredentialsMissingError, CalProviderError } from '../../services/cal-com-tool-client.js';
import { normalizePhoneE164 } from '../../services/phone-normalization.js';
import { toolParamsSchema, bookingBodySchema, bookingResponseSchema, isValidDateString } from '../../schemas/tool-routes.js';

const DEGRADED_MESSAGE = 'No puedo agendar la cita en este momento, ¿te llamo de vuelta para confirmarla?';
const MISSING_CONTACT_MESSAGE = 'Para confirmar tu cita necesito al menos tu número de teléfono o tu correo electrónico, ¿me compartes uno de los dos?';
// appointments.end_time es NOT NULL, pero Cal.com no siempre devuelve `end`
// en la respuesta de /bookings. Se usa la duración del evento configurada
// no está disponible en este punto (solo el eventTypeId), así que se aplica
// un respaldo conservador de 30 minutos — mismo valor que ya usaba
// services/calendar.ts para el mismo caso.
const DEFAULT_APPOINTMENT_DURATION_MS = 30 * 60 * 1000;

/**
 * POST /tools/:webhookToken/booking — Fase 5.2.
 * Idempotente por `conversationId`: un reintento del agente de voz (o de
 * ElevenLabs por una respuesta lenta) no debe producir una segunda cita.
 */
export async function bookingToolRoute(fastify: FastifyInstance) {
    fastify.post('/tools/:webhookToken/booking', async (request: FastifyRequest, reply: FastifyReply) => {
        const paramsResult = toolParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'webhookToken inválido en la ruta' });
        }

        const secretHeader = request.headers['x-tool-secret'] as string | undefined;
        const auth = await resolveToolOrganization(fastify, paramsResult.data.webhookToken, secretHeader);
        if (!auth.ok) {
            const statusCode = auth.reason === 'suspended' ? 403 : 401;
            request.log.warn({ reason: auth.reason, route: 'booking', msg: 'Tool call rechazado' });
            return reply.status(statusCode).send({
                error: statusCode === 403 ? 'Forbidden' : 'Unauthorized',
                message: auth.message,
            });
        }

        const bodyResult = bookingBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Cuerpo de la petición inválido' });
        }
        const { conversationId, customerName, customerPhone, customerEmail, startTime, timeZone } = bodyResult.data;

        if (!isValidDateString(startTime)) {
            return reply.status(400).send({ error: 'BadRequest', message: 'startTime no es una fecha válida' });
        }

        // Un canal sin caller ID (web chat) puede no traer teléfono, y el
        // cliente puede no dar correo por voz — pero no ambos a la vez: sin
        // ninguna forma de contacto no hay a quién confirmarle la cita.
        if (!customerPhone && !customerEmail) {
            return reply.status(200).send(
                bookingResponseSchema.parse({ booked: false, message: MISSING_CONTACT_MESSAGE })
            );
        }

        if (!auth.calEventTypeId) {
            request.log.error({ organizationId: auth.organizationId, msg: 'Organización sin cal_event_type_id configurado' });
            return reply.status(200).send(degradedResponse());
        }

        // Idempotencia: un reintento con el mismo conversationId devuelve la
        // cita ya creada en vez de duplicarla (ux_appointments_org_conversation_id).
        const { data: existing } = await fastify.supabaseAdmin
            .from('appointments')
            .select('id, start_time')
            .eq('organization_id', auth.organizationId)
            .eq('conversation_id', conversationId)
            .maybeSingle();

        if (existing) {
            return reply.status(200).send(
                bookingResponseSchema.parse({
                    booked: true,
                    message: `Ya tenías esta cita confirmada para ${existing.start_time}.`,
                    startTime: existing.start_time,
                    appointmentId: existing.id,
                })
            );
        }

        const contactId = customerPhone
            ? await upsertContactBestEffort(fastify, auth.organizationId, customerName, customerPhone, customerEmail ?? null)
            : null;

        try {
            const calResult = await withToolTimeout((signal) =>
                createBooking(
                    fastify,
                    auth.organizationId,
                    {
                        eventTypeId: auth.calEventTypeId!,
                        customerName,
                        customerEmail: customerEmail ?? null,
                        customerPhone: customerPhone ?? null,
                        startTime,
                        timeZone,
                    },
                    signal
                )
            );

            const { data: appointment, error: insertError } = await fastify.supabaseAdmin
                .from('appointments')
                .insert({
                    organization_id: auth.organizationId,
                    contact_id: contactId,
                    conversation_id: conversationId,
                    customer_name: customerName,
                    customer_email: customerEmail ?? null,
                    customer_phone: customerPhone ?? null,
                    start_time: calResult.startTime,
                    end_time: calResult.endTime ?? new Date(new Date(calResult.startTime).getTime() + DEFAULT_APPOINTMENT_DURATION_MS).toISOString(),
                    cal_booking_id: calResult.calBookingId,
                    status: 'confirmed',
                })
                .select('id, start_time')
                .single();

            if (insertError) {
                if (insertError.code === '23505') {
                    // Carrera: otra instancia insertó la misma conversationId primero.
                    const { data: raceWinner } = await fastify.supabaseAdmin
                        .from('appointments')
                        .select('id, start_time')
                        .eq('organization_id', auth.organizationId)
                        .eq('conversation_id', conversationId)
                        .maybeSingle();

                    return reply.status(200).send(
                        bookingResponseSchema.parse({
                            booked: true,
                            message: `Cita confirmada para ${raceWinner?.start_time ?? calResult.startTime}.`,
                            startTime: raceWinner?.start_time ?? calResult.startTime,
                            appointmentId: raceWinner?.id ?? null,
                        })
                    );
                }

                request.log.error({ organizationId: auth.organizationId, err: insertError.message, msg: 'Cita creada en Cal.com pero falló la inserción en appointments' });
                return reply.status(200).send(degradedResponse());
            }

            return reply.status(200).send(
                bookingResponseSchema.parse({
                    booked: true,
                    message: `Cita confirmada para ${appointment.start_time}.`,
                    startTime: appointment.start_time,
                    appointmentId: appointment.id,
                })
            );
        } catch (err) {
            logDegradedFailure(request, auth.organizationId, err);
            return reply.status(200).send(degradedResponse());
        }
    });
}

async function upsertContactBestEffort(
    fastify: FastifyInstance,
    organizationId: string,
    fullName: string,
    rawPhone: string,
    email: string | null
): Promise<string | null> {
    const normalized = normalizePhoneE164(rawPhone);
    if (!normalized.success || !normalized.phoneE164) {
        return null;
    }

    const { data, error } = await fastify.supabaseAdmin
        .from('contacts')
        .upsert(
            {
                organization_id: organizationId,
                phone_e164: normalized.phoneE164,
                full_name: fullName,
                email: email ?? undefined,
                last_seen_at: new Date().toISOString(),
            },
            { onConflict: 'organization_id,phone_e164', ignoreDuplicates: false }
        )
        .select('id')
        .single();

    if (error || !data) {
        fastify.log.warn({ organizationId, err: error?.message, msg: 'No se pudo resolver contact_id para la cita, se continúa sin él' });
        return null;
    }

    return data.id as string;
}

function degradedResponse() {
    return bookingResponseSchema.parse({ booked: false, message: DEGRADED_MESSAGE });
}

function logDegradedFailure(request: FastifyRequest, organizationId: string, err: unknown): void {
    const errName = err instanceof Error ? err.name : 'UnknownError';
    const errMessage = err instanceof Error ? err.message : String(err);

    if (err instanceof CalCredentialsMissingError) {
        request.log.error({ organizationId, msg: 'Tool degradado: cal_api_key no configurado' });
    } else if (err instanceof ToolTimeoutError) {
        request.log.warn({ organizationId, msg: 'Tool degradado: timeout creando la reserva en Cal.com' });
    } else if (err instanceof CalProviderError) {
        request.log.warn({ organizationId, status: err.status, msg: 'Tool degradado: Cal.com respondió error' });
    } else {
        request.log.error({ organizationId, errName, errMessage, msg: 'Tool degradado: error inesperado' });
    }
}

export default bookingToolRoute;
