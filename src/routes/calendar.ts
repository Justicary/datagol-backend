import { FastifyPluginAsync } from 'fastify';
import { supabaseAdmin } from '../lib/supabase.js';
import { getAvailableSlots, createBooking, rescheduleBooking, updateAppointmentStatus } from '../services/calendar.js';

interface GetSlotsBody {
    eventTypeId: number;
    startTime: string;
    endTime: string;
    timeZone?: string;
}

interface CreateBookingRouteBody {
    organizationId: string;
    callLogId?: string;
    eventTypeId: number;
    customerName: string;
    customerEmail?: string;
    customerPhone: string;
    startTime: string;
    timeZone?: string;
    serviceAddress?: string;
    latitude?: number;
    longitude?: number;
}

interface RescheduleRouteBody {
    appointmentId?: string;
    calBookingId?: string;
    newStartTime: string;
    reason?: string;
}

interface UpdateStatusParams {
    id: string;
}

interface UpdateStatusBody {
    status: 'confirmed' | 'cancelled' | 'rescheduled' | string;
    reason?: string;
}

/**
 * Plugin de Fastify para la gestión de Agendamiento de Citas con Cal.com.
 */
export const calendarRoutes: FastifyPluginAsync = async (fastify) => {
    /**
     * POST /api/calendar/slots
     * Obtiene los horarios disponibles para un eventTypeId en un rango de tiempo.
     */
    fastify.post<{ Body: GetSlotsBody }>('/api/calendar/slots', async (request, reply) => {
        try {
            const { eventTypeId, startTime, endTime, timeZone = 'America/Mexico_City' } = request.body || {};

            if (!eventTypeId || typeof eventTypeId !== 'number') {
                return reply.status(400).send({
                    status: 'error',
                    message: 'El campo "eventTypeId" es obligatorio y debe ser un número.',
                });
            }

            if (!startTime || typeof startTime !== 'string' || startTime.trim() === '') {
                return reply.status(400).send({
                    status: 'error',
                    message: 'El campo "startTime" (ISO string) es obligatorio.',
                });
            }

            if (!endTime || typeof endTime !== 'string' || endTime.trim() === '') {
                return reply.status(400).send({
                    status: 'error',
                    message: 'El campo "endTime" (ISO string) es obligatorio.',
                });
            }

            const slots = await getAvailableSlots(eventTypeId, startTime.trim(), endTime.trim(), timeZone);

            return reply.status(200).send({
                status: 'success',
                data: slots,
            });
        } catch (err: any) {
            fastify.log.error(err, 'Error al consultar disponibilidad en Cal.com');
            return reply.status(500).send({
                status: 'error',
                message: err.message || 'Error interno al consultar disponibilidad en el calendario.',
            });
        }
    });

    /**
     * POST /api/calendar/book
     * Crea una cita en Cal.com y la registra en la tabla appointments de Supabase.
     */
    fastify.post<{ Body: CreateBookingRouteBody }>('/api/calendar/book', async (request, reply) => {
        try {
            const {
                organizationId,
                callLogId,
                eventTypeId,
                customerName,
                customerEmail,
                customerPhone,
                startTime,
                timeZone = 'America/Mexico_City',
                serviceAddress,
                latitude,
                longitude,
            } = request.body || {};

            if (!organizationId || typeof organizationId !== 'string' || organizationId.trim() === '') {
                return reply.status(400).send({
                    status: 'error',
                    message: 'El campo "organizationId" es obligatorio.',
                });
            }

            if (!eventTypeId || typeof eventTypeId !== 'number') {
                return reply.status(400).send({
                    status: 'error',
                    message: 'El campo "eventTypeId" es obligatorio y debe ser un número.',
                });
            }

            if (!customerName || typeof customerName !== 'string' || customerName.trim() === '') {
                return reply.status(400).send({
                    status: 'error',
                    message: 'El campo "customerName" es obligatorio.',
                });
            }

            if (!customerPhone || typeof customerPhone !== 'string' || customerPhone.trim() === '') {
                return reply.status(400).send({
                    status: 'error',
                    message: 'El campo "customerPhone" es obligatorio.',
                });
            }

            if (!startTime || typeof startTime !== 'string' || startTime.trim() === '') {
                return reply.status(400).send({
                    status: 'error',
                    message: 'El campo "startTime" es obligatorio.',
                });
            }

            const bookingResult = await createBooking({
                organizationId: organizationId.trim(),
                callLogId: callLogId ? callLogId.trim() : undefined,
                eventTypeId,
                customerName: customerName.trim(),
                customerEmail: customerEmail ? customerEmail.trim() : undefined,
                customerPhone: customerPhone.trim(),
                startTime: startTime.trim(),
                timeZone,
                serviceAddress: serviceAddress ? serviceAddress.trim() : undefined,
                latitude,
                longitude,
            });

            return reply.status(201).send({
                status: 'success',
                message: 'Cita reservada y registrada exitosamente',
                data: bookingResult,
            });
        } catch (err: any) {
            fastify.log.error(err, 'Error al crear la reserva de cita');
            return reply.status(500).send({
                status: 'error',
                message: err.message || 'Error interno al agendar la cita.',
            });
        }
    });

    /**
     * POST /api/calendar/reschedule
     * Reprograma una cita existente en Cal.com v2 y Supabase.
     */
    fastify.post<{ Body: RescheduleRouteBody }>('/api/calendar/reschedule', async (request, reply) => {
        try {
            const { appointmentId, calBookingId, newStartTime, reason } = request.body || {};

            if (!newStartTime || typeof newStartTime !== 'string' || newStartTime.trim() === '') {
                return reply.status(400).send({
                    status: 'error',
                    message: 'El campo "newStartTime" es obligatorio.',
                });
            }

            if (!appointmentId && !calBookingId) {
                return reply.status(400).send({
                    status: 'error',
                    message: 'Se requiere "appointmentId" o "calBookingId" para reprogramar la cita.',
                });
            }

            const result = await rescheduleBooking({
                appointmentId: appointmentId ? appointmentId.trim() : undefined,
                calBookingId: calBookingId ? calBookingId.trim() : undefined,
                newStartTime: newStartTime.trim(),
                reason,
            });

            return reply.status(200).send({
                status: 'success',
                message: 'Cita reprogramada exitosamente',
                data: result,
            });
        } catch (err: any) {
            fastify.log.error(err, 'Error al reprogramar la cita');
            return reply.status(500).send({
                status: 'error',
                message: err.message || 'Error interno al reprogramar la cita.',
            });
        }
    });

    /**
     * PATCH /api/calendar/appointments/:id/status
     * Actualiza el estado de una cita en Supabase (ej: 'confirmed', 'cancelled', 'rescheduled').
     */
    fastify.patch<{ Params: UpdateStatusParams; Body: UpdateStatusBody }>(
        '/api/calendar/appointments/:id/status',
        async (request, reply) => {
            try {
                const { id } = request.params;
                const { status, reason } = request.body || {};

                if (!id || typeof id !== 'string' || id.trim() === '') {
                    return reply.status(400).send({
                        status: 'error',
                        message: 'El parámetro de ruta "id" es obligatorio.',
                    });
                }

                if (!status || typeof status !== 'string' || status.trim() === '') {
                    return reply.status(400).send({
                        status: 'error',
                        message: 'El campo "status" es obligatorio.',
                    });
                }

                const updated = await updateAppointmentStatus({
                    appointmentId: id.trim(),
                    status: status.trim(),
                    reason,
                });

                return reply.status(200).send({
                    status: 'success',
                    message: 'Estado de la cita actualizado exitosamente',
                    data: updated,
                });
            } catch (err: any) {
                fastify.log.error(err, 'Error actualizando estado de la cita');
                return reply.status(500).send({
                    status: 'error',
                    message: err.message || 'Error interno al actualizar el estado de la cita.',
                });
            }
        }
    );

    /**
     * POST /api/calendar/confirm-call
     * Dispara una llamada Outbound a través de Vapi AI para confirmar la cita de un usuario con credenciales multi-tenant.
     */
    fastify.post('/api/calendar/confirm-call', async (request, reply) => {
        try {
            const body = (request.body || {}) as any;
            const { appointmentId } = body;

            if (!appointmentId && !body.calBookingId) {
                return reply.status(400).send({
                    status: 'error',
                    message: 'Se requiere "appointmentId" o "calBookingId" para buscar la cita.',
                });
            }

            // 1. Obtener cita y credenciales de la organización asociada
            let query = supabaseAdmin
                .from('appointments')
                .select('*, organizations(id, vapi_private_key, vapi_agent_id, vapi_phone_number_id, name)');

            if (appointmentId) {
                query = query.eq('id', appointmentId);
            } else {
                query = query.eq('cal_booking_id', body.calBookingId);
            }

            const { data: appointment, error } = await query.maybeSingle();

            if (error || !appointment) {
                return reply.status(404).send({ status: 'error', message: 'Cita no encontrada.' });
            }

            const org = appointment.organizations as any;
            const vapiPrivateKey = org?.vapi_private_key || process.env.VAPI_PRIVATE_KEY;
            const vapiAgentId = org?.vapi_agent_id || process.env.VAPI_AGENT_ID;
            const vapiPhoneNumberId = org?.vapi_phone_number_id || process.env.VAPI_PHONE_NUMBER_ID;

            if (!vapiPrivateKey || !vapiAgentId) {
                return reply.status(500).send({ status: 'error', message: 'Faltan credenciales VAPI configuradas para la organización.' });
            }

            // 2. Disparar llamada saliente personalizada
            const vapiPayload: any = {
                assistantId: vapiAgentId,
                customer: {
                    number: appointment.customer_phone,
                    name: appointment.customer_name || 'Cliente'
                },
                assistantOverrides: {
                    variableValues: {
                        customerName: appointment.customer_name || 'Cliente',
                        companyName: org?.name || 'Datagol',
                        demoObjective: `Confirmar asistencia a cita agendada para ${appointment.start_time}`
                    }
                }
            };

            if (vapiPhoneNumberId) vapiPayload.phoneNumberId = vapiPhoneNumberId;

            const vapiRes = await fetch('https://api.vapi.ai/call', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${vapiPrivateKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(vapiPayload)
            });

            const vapiData = await vapiRes.json();

            if (!vapiRes.ok) {
                request.log.error({ vapiData }, 'Error devuelto por Vapi API en confirm-call');
                return reply.status(vapiRes.status).send({
                    status: 'error',
                    message: vapiData.message || 'Error al iniciar la llamada en Vapi API',
                    details: vapiData
                });
            }

            return reply.send({
                status: 'success',
                message: 'Llamada outbound de confirmación iniciada exitosamente',
                appointment,
                vapiCall: vapiData
            });
        } catch (err: any) {
            fastify.log.error(err, 'Error en POST /api/calendar/confirm-call');
            return reply.status(500).send({
                status: 'error',
                message: err.message || 'Error interno al procesar la llamada de confirmación',
            });
        }
    });
};

export default calendarRoutes;
