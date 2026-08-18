import { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { withToolTimeout } from '../lib/tool-timeout.js';
import { APPOINTMENT_STATUSES } from '../types/appointment-status.js';
import {
    getAvailableSlots as calGetAvailableSlots,
    createBooking as calCreateBooking,
    rescheduleBooking as calRescheduleBooking,
    cancelBooking as calCancelBooking,
    CalCredentialsMissingError,
    CalProviderError,
} from './cal-com-tool-client.js';

const DEFAULT_APPOINTMENT_DURATION_MS = 30 * 60 * 1000;

/**
 * Handler de tool-calling de calendario para el proveedor Vapi
 * (routes/vapi.ts). Delega toda la integración con Cal.com a
 * cal-com-tool-client.ts — el mismo cliente tenant-scoped que usan las rutas
 * /tools/:webhookToken/** de ElevenLabs (Fase 5) — en vez de mantener una
 * segunda implementación con credenciales globales (process.env.CAL_API_KEY):
 * eso permitía que un tool-call resolviera el Cal.com equivocado según qué
 * organización tuviera configurada esa variable de entorno, y fue la causa
 * raíz de un bug de producción real (bookings que siempre fallaban).
 *
 * `organizationId` lo resuelve el llamador (routes/vapi.ts, vía
 * organizations.vapi_agent_id) ANTES de invocar esto — nunca se toma de
 * `args`, que es contenido generado por el LLM (AGENTS.md §5.1). Todas las
 * consultas/actualizaciones a `appointments` están además filtradas por
 * `organization_id`: sin eso, un tool-call de la organización A podía leer o
 * modificar una cita de la organización B con solo adivinar su UUID.
 */
export async function handleCalendarToolCall(
    fastify: FastifyInstance,
    organizationId: string,
    toolName: string,
    args: Record<string, any>
): Promise<string> {
    const normalizedName = (toolName || '').trim();

    const { data: org, error: orgError } = await supabaseAdmin
        .from('organizations')
        .select('cal_event_type_id')
        .eq('id', organizationId)
        .maybeSingle();

    if (orgError || !org) {
        logger.error({ organizationId, err: orgError?.message }, 'No se pudo resolver la organización para tool-call de calendario (Vapi)');
        return 'No se pudo identificar la configuración de agenda de esta organización.';
    }

    if (normalizedName === 'checkAvailability' || normalizedName === 'getAvailableSlots' || normalizedName === 'check_availability') {
        const eventTypeId = Number(args.eventTypeId ?? org.cal_event_type_id);
        const startTime = args.start || args.startTime;
        const endTime = args.end || args.endTime;
        const timeZone = args.timeZone || 'America/Mexico_City';

        if (!eventTypeId || !startTime || !endTime) {
            return 'Faltan parámetros requeridos para consultar disponibilidad (startTime, endTime).';
        }

        try {
            const slots = await withToolTimeout((signal) =>
                calGetAvailableSlots(fastify, organizationId, { eventTypeId, startTime: String(startTime), endTime: String(endTime), timeZone }, signal)
            );

            if (slots.length === 0) {
                return 'No se encontraron horarios disponibles para la fecha y rango solicitados.';
            }
            const timesList = slots.slice(0, 8).map((s) => s.time).join(', ');
            return `Horarios disponibles encontrados (${slots.length}): ${timesList}`;
        } catch (err) {
            logCalendarFailure(organizationId, 'checkAvailability', err);
            return 'No puedo consultar la agenda en este momento, ¿te llamo de vuelta?';
        }
    }

    if (normalizedName === 'bookAppointment' || normalizedName === 'createBooking' || normalizedName === 'book_appointment') {
        const customerName = args.customerName;
        const customerEmail = args.customerEmail ? String(args.customerEmail) : null;
        const customerPhone = args.customerPhone ? String(args.customerPhone) : null;
        const startTime = args.startTime || args.start;
        const timeZone = args.timeZone || 'America/Mexico_City';
        const eventTypeId = Number(args.eventTypeId ?? org.cal_event_type_id);

        if (!customerName || !startTime || !eventTypeId) {
            return 'Faltan datos obligatorios para agendar la cita (customerName, startTime).';
        }
        if (!customerPhone && !customerEmail) {
            return 'Para confirmar tu cita necesito al menos tu número de teléfono o tu correo electrónico.';
        }

        try {
            const calResult = await withToolTimeout((signal) =>
                calCreateBooking(
                    fastify,
                    organizationId,
                    { eventTypeId, customerName: String(customerName), customerEmail, customerPhone, startTime: String(startTime), timeZone },
                    signal
                )
            );

            const { error: insertError } = await supabaseAdmin
                .from('appointments')
                .insert({
                    organization_id: organizationId,
                    customer_name: String(customerName),
                    customer_email: customerEmail,
                    customer_phone: customerPhone,
                    start_time: calResult.startTime,
                    end_time: calResult.endTime ?? new Date(new Date(calResult.startTime).getTime() + DEFAULT_APPOINTMENT_DURATION_MS).toISOString(),
                    cal_booking_id: calResult.calBookingId,
                    status: APPOINTMENT_STATUSES.CONFIRMADA,
                });

            if (insertError) {
                logger.error({ organizationId, err: insertError.message }, 'Cita creada en Cal.com pero falló la inserción en appointments (Vapi)');
                return 'Tu cita se agendó, pero tuvimos un problema registrándola internamente. Un agente humano la confirmará contigo.';
            }

            return `Cita agendada correctamente para ${customerName} el ${calResult.startTime}.`;
        } catch (err) {
            logCalendarFailure(organizationId, 'bookAppointment', err);
            return 'No puedo agendar la cita en este momento, ¿te llamo de vuelta para confirmarla?';
        }
    }

    if (
        normalizedName === 'rescheduleAppointment' ||
        normalizedName === 'modifyAppointment' ||
        normalizedName === 'updateAppointment' ||
        normalizedName === 'changeAppointment'
    ) {
        const { appointmentId, calBookingId, reason } = args || {};
        const newStartTime = args.newStartTime || args.startTime || args.start;

        if (!newStartTime || (!appointmentId && !calBookingId)) {
            return 'Falta la nueva fecha/hora o el identificador de la cita para modificarla.';
        }

        const appointment = await findAppointment(organizationId, appointmentId, calBookingId);
        if (!appointment || !appointment.cal_booking_id) {
            return 'No encontré esa cita para esta organización.';
        }

        try {
            const calResult = await withToolTimeout((signal) =>
                calRescheduleBooking(
                    fastify,
                    organizationId,
                    { calBookingId: appointment.cal_booking_id as string, newStartTime: String(newStartTime), reason: reason ? String(reason) : undefined },
                    signal
                )
            );

            // end_time es NOT NULL; si Cal.com no devuelve `end`, se preserva
            // la duración original en vez de asumir un valor arbitrario.
            const originalDurationMs = new Date(appointment.end_time).getTime() - new Date(appointment.start_time).getTime();
            const fallbackEndTime = new Date(new Date(calResult.startTime).getTime() + originalDurationMs).toISOString();

            const { error: updateError } = await supabaseAdmin
                .from('appointments')
                .update({ start_time: calResult.startTime, end_time: calResult.endTime ?? fallbackEndTime, status: APPOINTMENT_STATUSES.REPROGRAMADA })
                .eq('id', appointment.id);

            if (updateError) {
                logger.error({ organizationId, appointmentId: appointment.id, err: updateError.message }, 'Cal.com reprogramó pero falló la actualización en appointments (Vapi)');
                return 'No puedo reprogramar la cita en este momento, ¿te llamo de vuelta?';
            }

            return `Cita reprogramada exitosamente para la nueva fecha: ${calResult.startTime}.`;
        } catch (err) {
            logCalendarFailure(organizationId, 'rescheduleAppointment', err);
            return 'No puedo reprogramar la cita en este momento, ¿te llamo de vuelta?';
        }
    }

    if (
        normalizedName === 'confirmAppointment' ||
        normalizedName === 'confirm_appointment' ||
        normalizedName === 'cancelAppointment' ||
        normalizedName === 'cancel_appointment'
    ) {
        const { appointmentId, calBookingId, reason } = args || {};
        const isCancel = normalizedName === 'cancelAppointment' || normalizedName === 'cancel_appointment';
        // El nombre de la herramienta ya determina el estado destino — nunca
        // se toma `args.status` (contenido generado por el LLM, sin
        // whitelist) para evitar escribir un valor arbitrario que viole el
        // CHECK constraint de appointments.status.
        const targetStatus = isCancel ? APPOINTMENT_STATUSES.CANCELADA : APPOINTMENT_STATUSES.CONFIRMADA;

        if (!appointmentId && !calBookingId) {
            return 'Se requiere el ID de la cita para actualizar su estado.';
        }

        const appointment = await findAppointment(organizationId, appointmentId, calBookingId);
        if (!appointment) {
            return 'No encontré esa cita para esta organización.';
        }

        const { error: updateError } = await supabaseAdmin.from('appointments').update({ status: targetStatus }).eq('id', appointment.id);
        if (updateError) {
            logger.error({ organizationId, appointmentId: appointment.id, err: updateError.message }, 'Error actualizando estado de cita (Vapi)');
            return 'No pude actualizar el estado de la cita en este momento.';
        }

        if (isCancel && appointment.cal_booking_id) {
            try {
                await withToolTimeout((signal) =>
                    calCancelBooking(fastify, organizationId, appointment.cal_booking_id as string, reason ? String(reason) : undefined, signal)
                );
            } catch (err) {
                logCalendarFailure(organizationId, 'cancelAppointment', err);
            }
        }

        return isCancel ? 'La cita ha sido cancelada correctamente.' : `El estado de la cita ha sido actualizado a '${targetStatus}' exitosamente.`;
    }

    return `Herramienta de calendario '${toolName}' no reconocida.`;
}

async function findAppointment(organizationId: string, appointmentId: unknown, calBookingId: unknown) {
    let query = supabaseAdmin
        .from('appointments')
        .select('id, cal_booking_id, start_time, end_time')
        .eq('organization_id', organizationId);

    query = appointmentId ? query.eq('id', String(appointmentId)) : query.eq('cal_booking_id', String(calBookingId));

    const { data } = await query.maybeSingle();
    return data;
}

function logCalendarFailure(organizationId: string, toolName: string, err: unknown): void {
    if (err instanceof CalCredentialsMissingError) {
        logger.error({ organizationId, toolName, msg: 'Tool de calendario degradado: cal_api_key no configurado (Vapi)' });
    } else if (err instanceof CalProviderError) {
        logger.warn({ organizationId, toolName, status: err.status, msg: 'Tool de calendario degradado: Cal.com respondió error (Vapi)' });
    } else {
        const errMessage = err instanceof Error ? err.message : String(err);
        logger.error({ organizationId, toolName, errMessage, msg: 'Tool de calendario degradado: error inesperado (Vapi)' });
    }
}
