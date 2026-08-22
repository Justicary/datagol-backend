import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveToolOrganization } from '../../lib/tool-auth.js';
import { normalizePhoneE164 } from '../../services/phone-normalization.js';
import {
    toolParamsSchema,
    appointmentBodySchema,
    appointmentResponseSchema,
    type AppointmentDetailsItem,
} from '../../schemas/tool-routes.js';
import { APPOINTMENT_STATUSES } from '../../types/appointment-status.js';

const DEGRADED_MESSAGE = 'No puedo consultar los detalles de tu cita en este momento, ¿te llamo de vuelta para confirmarla?';
const NOT_FOUND_MESSAGE =
    'No encontré ninguna cita programada a tu nombre con los datos proporcionados. ¿Deseas que te ayude a agendar una?';
const MISSING_IDENTIFIERS_MESSAGE =
    'Para consultar los detalles de tu cita necesito al menos tu número de teléfono, correo electrónico o nombre completo, ¿me compartes alguno?';

export function formatSpanishAppointmentDate(isoString: string, timeZone: string): string {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
        return isoString;
    }

    try {
        const dayFormatter = new Intl.DateTimeFormat('es-MX', {
            timeZone,
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
        });
        const timeFormatter = new Intl.DateTimeFormat('es-MX', {
            timeZone,
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
        });
        const dateStr = dayFormatter.format(date);
        const timeStr = timeFormatter.format(date);
        return `${dateStr} a las ${timeStr}`;
    } catch {
        return date.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
    }
}

function buildAppointmentMessage(
    formattedDate: string,
    serviceAddress: string | null
): string {
    const addressPart = serviceAddress ? ` con ubicación en ${serviceAddress}` : '';
    return `Tienes una cita programada para el ${formattedDate}${addressPart}.`;
}

/**
 * POST /tools/:webhookToken/appointment y POST /tools/:webhookToken/appointment-details
 * Permite al agente de ElevenLabs / Vapi consultar los detalles y horario de una cita
 * existente durante la llamada de voz (<300ms) cuando el cliente pregunta
 * "¿A qué hora es mi cita?" o pide confirmación de sus datos.
 */
export async function appointmentToolRoute(fastify: FastifyInstance) {
    const handleAppointmentLookup = async (request: FastifyRequest, reply: FastifyReply) => {
        const paramsResult = toolParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'webhookToken inválido en la ruta' });
        }

        const secretHeader = request.headers['x-tool-secret'] as string | undefined;
        const auth = await resolveToolOrganization(fastify, paramsResult.data.webhookToken, secretHeader);
        if (!auth.ok) {
            const statusCode = auth.reason === 'suspended' ? 403 : 401;
            request.log.warn({ reason: auth.reason, route: 'appointment', msg: 'Tool call rechazado' });
            return reply.status(statusCode).send({
                error: statusCode === 403 ? 'Forbidden' : 'Unauthorized',
                message: auth.message,
            });
        }

        const bodyResult = appointmentBodySchema.safeParse(request.body || {});
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Cuerpo de la petición inválido' });
        }
        const { customerPhone, customerEmail, customerName } = bodyResult.data;

        if (!customerPhone && !customerEmail && !customerName) {
            return reply.status(200).send(
                appointmentResponseSchema.parse({
                    found: false,
                    message: MISSING_IDENTIFIERS_MESSAGE,
                    appointment: null,
                })
            );
        }

        try {
            // 1. Obtener zona horaria de la organización para formatear la fecha verbalizada
            const { data: orgData } = await fastify.supabaseAdmin
                .from('organizations')
                .select('timezone')
                .eq('id', auth.organizationId)
                .maybeSingle();

            const timeZone = orgData?.timezone || 'America/Mexico_City';

            // 2. Construir consulta sobre appointments filtrando por tenant y citas activas
            // Consideramos citas desde 2 horas antes de ahora para cubrir citas que estén iniciando
            const lookbackTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

            let appointmentQuery = fastify.supabaseAdmin
                .from('appointments')
                .select('id, organization_id, customer_name, customer_email, customer_phone, service_address, start_time, end_time, status')
                .eq('organization_id', auth.organizationId)
                .neq('status', APPOINTMENT_STATUSES.CANCELADA)
                .gte('start_time', lookbackTime);

            const normalizedPhone = customerPhone ? normalizePhoneE164(customerPhone) : null;
            const phoneToMatch = normalizedPhone?.success ? normalizedPhone.phoneE164 : customerPhone?.trim();

            if (phoneToMatch && customerEmail) {
                appointmentQuery = appointmentQuery.or(
                    `customer_phone.eq.${phoneToMatch},customer_email.ilike.${customerEmail.trim()}`
                );
            } else if (phoneToMatch) {
                appointmentQuery = appointmentQuery.eq('customer_phone', phoneToMatch);
            } else if (customerEmail) {
                appointmentQuery = appointmentQuery.ilike('customer_email', customerEmail.trim());
            } else if (customerName) {
                appointmentQuery = appointmentQuery.ilike('customer_name', customerName.trim());
            }

            const { data: appointment, error: lookupError } = await appointmentQuery
                .order('start_time', { ascending: true })
                .limit(1)
                .maybeSingle();

            if (lookupError) {
                request.log.error({
                    organizationId: auth.organizationId,
                    err: lookupError.message,
                    msg: 'Error consultando appointments para appointment lookup',
                });
                return reply.status(200).send(
                    appointmentResponseSchema.parse({
                        found: false,
                        message: DEGRADED_MESSAGE,
                        appointment: null,
                    })
                );
            }

            if (!appointment) {
                return reply.status(200).send(
                    appointmentResponseSchema.parse({
                        found: false,
                        message: NOT_FOUND_MESSAGE,
                        appointment: null,
                    })
                );
            }

            const formattedDate = formatSpanishAppointmentDate(appointment.start_time, timeZone);
            const message = buildAppointmentMessage(formattedDate, appointment.service_address ?? null);

            const appointmentData: AppointmentDetailsItem = {
                id: appointment.id,
                customerName: appointment.customer_name,
                customerEmail: appointment.customer_email ?? null,
                customerPhone: appointment.customer_phone ?? null,
                startTime: appointment.start_time,
                endTime: appointment.end_time,
                formattedDate,
                timeZone,
                serviceAddress: appointment.service_address ?? null,
                status: appointment.status,
            };

            return reply.status(200).send(
                appointmentResponseSchema.parse({
                    found: true,
                    message,
                    appointment: appointmentData,
                })
            );
        } catch (err) {
            request.log.error({
                organizationId: auth.organizationId,
                err: err instanceof Error ? err.message : String(err),
                msg: 'Error inesperado consultando appointment',
            });
            return reply.status(200).send(
                appointmentResponseSchema.parse({
                    found: false,
                    message: DEGRADED_MESSAGE,
                    appointment: null,
                })
            );
        }
    };

    fastify.post('/tools/:webhookToken/appointment', handleAppointmentLookup);
    fastify.post('/tools/:webhookToken/appointment-details', handleAppointmentLookup);
}

export default appointmentToolRoute;
