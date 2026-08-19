import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveToolOrganization } from '../../lib/tool-auth.js';
import { withToolTimeout, ToolTimeoutError } from '../../lib/tool-timeout.js';
import { createBooking, CalCredentialsMissingError, CalProviderError } from '../../services/cal-com-tool-client.js';
import { normalizePhoneE164 } from '../../services/phone-normalization.js';
import { CONTACT_ADDRESS_TYPES } from '../../types/contact-enums.js';
import { APPOINTMENT_STATUSES } from '../../types/appointment-status.js';
import {
    toolParamsSchema,
    bookingBodySchema,
    bookingResponseSchema,
    isValidDateString,
    type ProposedAddress,
} from '../../schemas/tool-routes.js';

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
        const { conversationId, customerName, customerPhone, customerEmail, startTime, timeZone, contactAddressId, serviceAddress } = bodyResult.data;

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

        const contactId = await resolveContactBestEffort(fastify, auth.organizationId, customerName, customerPhone ?? null, customerEmail ?? null);

        // Fase C (docs/tasks/opus.md): resolver la dirección de la cita.
        // Prioridad: contactAddressId explícito (el agente ya confirmó
        // reutilizar una dirección propuesta) > serviceAddress nuevo
        // (dictado en esta llamada, se consolida vía resolve_contact_address)
        // > ninguno de los dos (se propone la dirección principal en
        // archivo, si existe, sin asignarla a la cita todavía).
        let finalContactAddressId: string | null = null;
        let finalServiceAddress: string | null = serviceAddress ?? null;
        let proposedAddress: ProposedAddress | null = null;

        if (contactAddressId && contactId) {
            const owned = await fetchOwnedContactAddress(fastify, auth.organizationId, contactId, contactAddressId);
            if (owned) {
                finalContactAddressId = owned.id;
                finalServiceAddress = finalServiceAddress ?? owned.street;
            } else {
                request.log.warn({ organizationId: auth.organizationId, contactId, contactAddressId, msg: 'contactAddressId no pertenece a este contacto, se ignora' });
            }
        }

        if (!finalContactAddressId && serviceAddress && contactId) {
            try {
                const resolvedAddressId = await withToolTimeout((signal) =>
                    resolveContactAddress(fastify, auth.organizationId, contactId, serviceAddress, signal)
                );
                finalContactAddressId = resolvedAddressId;
            } catch (err) {
                request.log.warn({ organizationId: auth.organizationId, contactId, err: err instanceof Error ? err.message : String(err), msg: 'No se pudo consolidar la dirección de la cita en contact_addresses, se guarda solo el texto' });
            }
        }

        if (!finalContactAddressId && !finalServiceAddress && contactId) {
            proposedAddress = await getCachedPrimaryAddress(fastify, conversationId, contactId);
        }

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
                    contact_address_id: finalContactAddressId,
                    conversation_id: conversationId,
                    customer_name: customerName,
                    customer_email: customerEmail ?? null,
                    customer_phone: customerPhone ?? null,
                    service_address: finalServiceAddress,
                    start_time: calResult.startTime,
                    end_time: calResult.endTime ?? new Date(new Date(calResult.startTime).getTime() + DEFAULT_APPOINTMENT_DURATION_MS).toISOString(),
                    cal_booking_id: calResult.calBookingId,
                    status: APPOINTMENT_STATUSES.CONFIRMADA,
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
                    proposedAddress,
                })
            );
        } catch (err) {
            logDegradedFailure(request, auth.organizationId, err);
            return reply.status(200).send(degradedResponse());
        }
    });
}

/**
 * Resuelve/crea el contacto de la cita vía `resolve_contact` (teléfono →
 * correo → nuevo, misma primitiva compartida que `process_call_completed`
 * — ver db/migrations/26/27_*.sql). A diferencia de ese caller, aquí no hay
 * lógica de deduplicación previa que preservar (el upsert manual que había
 * antes no tenía fallback por correo), así que `resolve_contact` es un
 * reemplazo directo, no una regresión.
 */
async function resolveContactBestEffort(
    fastify: FastifyInstance,
    organizationId: string,
    fullName: string,
    rawPhone: string | null,
    email: string | null
): Promise<string | null> {
    const normalized = rawPhone ? normalizePhoneE164(rawPhone) : null;
    const phoneE164 = normalized?.success ? normalized.phoneE164 : null;

    if (!phoneE164 && !email) {
        return null;
    }

    const { data: contactId, error } = await fastify.supabaseAdmin.rpc('resolve_contact', {
        p_org_id: organizationId,
        p_phone: phoneE164,
        p_email: email,
    });

    if (error || !contactId) {
        fastify.log.warn({ organizationId, err: error?.message, msg: 'No se pudo resolver contact_id para la cita, se continúa sin él' });
        return null;
    }

    const { error: updateError } = await fastify.supabaseAdmin
        .from('contacts')
        .update({ full_name: fullName })
        .eq('id', contactId)
        .is('full_name', null);
    if (updateError) {
        fastify.log.warn({ organizationId, contactId, err: updateError.message, msg: 'No se pudo actualizar el nombre del contacto (no bloquea la cita)' });
    }

    return contactId as string;
}

async function fetchOwnedContactAddress(
    fastify: FastifyInstance,
    organizationId: string,
    contactId: string,
    addressId: string
): Promise<{ id: string; street: string } | null> {
    const { data } = await fastify.supabaseAdmin
        .from('contact_addresses')
        .select('id, street')
        .eq('id', addressId)
        .eq('organization_id', organizationId)
        .eq('contact_id', contactId)
        .is('archived_at', null)
        .maybeSingle();
    return data ?? null;
}

async function resolveContactAddress(
    fastify: FastifyInstance,
    organizationId: string,
    contactId: string,
    street: string,
    signal: AbortSignal
): Promise<string | null> {
    const { data, error } = await fastify.supabaseAdmin
        .rpc('resolve_contact_address', {
            p_org_id: organizationId,
            p_contact_id: contactId,
            p_street: street,
            p_type: CONTACT_ADDRESS_TYPES.DOMICILIO,
        })
        .abortSignal(signal);
    if (error) throw new Error(error.message);
    return (data as string | null) ?? null;
}

// Caché de la dirección principal propuesta (Fase C, AGENTS.md §3: p95 <
// 300 ms en routes/tools/**), llave por contactId — un superconjunto de
// "por conversación" (una conversación tiene un solo contactId, pero el
// mismo contacto puede llamar dos veces en la misma ventana de caché sin
// repetir la consulta). Una conversación de voz rara vez excede unos pocos
// minutos; el TTL es generoso a propósito — el costo de una entrada
// obsoleta es mostrar una dirección desactualizada por unos minutos, no un
// problema de seguridad ni de dinero.
const PRIMARY_ADDRESS_CACHE_TTL_MS = 5 * 60 * 1000;
const primaryAddressCache = new Map<string, { address: ProposedAddress | null; expiresAt: number }>();

async function getCachedPrimaryAddress(fastify: FastifyInstance, conversationId: string, contactId: string): Promise<ProposedAddress | null> {
    const cacheKey = `${contactId}`;
    const now = Date.now();
    const cached = primaryAddressCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        return cached.address;
    }

    try {
        const address = await withToolTimeout(async (signal) => {
            const { data, error } = await fastify.supabaseAdmin
                .from('v_contact_primary_address')
                .select('address_id, street, neighborhood, city, state, postal_code')
                .eq('contact_id', contactId)
                .abortSignal(signal)
                .maybeSingle();
            if (error) throw new Error(error.message);
            if (!data) return null;
            return {
                addressId: data.address_id,
                street: data.street,
                neighborhood: data.neighborhood,
                city: data.city,
                state: data.state,
                postalCode: data.postal_code,
            } satisfies ProposedAddress;
        });
        primaryAddressCache.set(cacheKey, { address, expiresAt: now + PRIMARY_ADDRESS_CACHE_TTL_MS });
        return address;
    } catch (err) {
        fastify.log.warn({ conversationId, contactId, err: err instanceof Error ? err.message : String(err), msg: 'No se pudo consultar la dirección principal del contacto, se omite la propuesta' });
        return null;
    }
}

/**
 * Invalida la caché de dirección principal en memoria. Se expone para pruebas.
 */
export function invalidatePrimaryAddressCache(): void {
    primaryAddressCache.clear();
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
