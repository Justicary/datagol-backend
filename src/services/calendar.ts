import dotenv from 'dotenv';
import { supabaseAdmin } from '../lib/supabase.js';

dotenv.config();

export interface CreateBookingParams {
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

export interface RescheduleBookingParams {
    appointmentId?: string;
    calBookingId?: string;
    newStartTime: string;
    reason?: string;
}

export interface UpdateStatusParams {
    appointmentId?: string;
    calBookingId?: string;
    status: 'confirmed' | 'cancelled' | 'rescheduled' | string;
    reason?: string;
}

const CAL_API_V2_BASE_URL = 'https://api.cal.com/v2';

/**
 * Consulta la disponibilidad de horarios en Cal.com utilizando la API v2.
 */
export async function getAvailableSlots(
    eventTypeId: number,
    startTime: string,
    endTime: string,
    timeZone: string = 'America/Mexico_City'
) {
    const apiKey = process.env.CAL_API_KEY;
    if (!apiKey) {
        throw new Error('Falta la variable de entorno CAL_API_KEY en el archivo .env');
    }

    const isoStart = new Date(startTime).toISOString();
    const isoEnd = new Date(endTime).toISOString();

    const url = new URL(`${CAL_API_V2_BASE_URL}/slots/available`);
    url.searchParams.append('eventTypeId', String(Number(eventTypeId)));
    url.searchParams.append('startTime', isoStart);
    url.searchParams.append('endTime', isoEnd);
    url.searchParams.append('timeZone', timeZone || 'America/Mexico_City');

    console.log(`📅 Consultando disponibilidad en Cal.com v2: ${url.toString()}`);

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'cal-api-version': '2024-08-13',
        },
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error(`❌ Error Cal.com v2 GET /slots/available (${response.status}):`, errText);
        throw new Error(`Error de Cal.com v2 API (${response.status}): ${errText}`);
    }

    const json = await response.json();
    const rawSlots = json.data?.slots || json.data || json.slots || json;

    const formattedSlots: Array<{ time: string }> = [];

    if (Array.isArray(rawSlots)) {
        for (const slot of rawSlots) {
            const timeStr = typeof slot === 'string' ? slot : (slot.start || slot.time || JSON.stringify(slot));
            formattedSlots.push({ time: timeStr });
        }
    } else if (typeof rawSlots === 'object' && rawSlots !== null) {
        for (const dateKey of Object.keys(rawSlots)) {
            const daySlots = rawSlots[dateKey];
            if (Array.isArray(daySlots)) {
                for (const slot of daySlots) {
                    const timeStr = typeof slot === 'string' ? slot : (slot.start || slot.time || JSON.stringify(slot));
                    formattedSlots.push({ time: timeStr });
                }
            }
        }
    }

    return formattedSlots;
}

/**
 * Crea una reserva en Cal.com utilizando la API v2 e inserta la cita en la tabla `appointments` de Supabase.
 */
export async function createBooking(params: CreateBookingParams) {
    const apiKey = process.env.CAL_API_KEY;
    if (!apiKey) {
        throw new Error('Falta la variable de entorno CAL_API_KEY en el archivo .env');
    }

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
    } = params;

    const bodyPayload = {
        start: startTime,
        eventTypeId: Number(eventTypeId),
        attendee: {
            name: customerName,
            email: customerEmail || 'cliente@datagol.net',
            timeZone: timeZone || 'America/Mexico_City',
            language: 'es',
        },
        bookingFieldsResponses: {
            location: 'phone',
            phone: customerPhone,
        },
    };

    console.log(`📌 Creando reserva en Cal.com v2:`, JSON.stringify(bodyPayload, null, 2));

    const response = await fetch(`${CAL_API_V2_BASE_URL}/bookings`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'cal-api-version': '2024-08-13',
        },
        body: JSON.stringify(bodyPayload),
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error(`❌ Error Cal.com v2 POST /bookings (${response.status}):`, errText);
        throw new Error(`Error al crear reserva en Cal.com v2 (${response.status}): ${errText}`);
    }

    const calData = await response.json();
    const booking = calData.data || calData.booking || calData;
    const calBookingId = String(booking.uid || booking.id || 'cal_booking_unknown');

    console.log(`✅ Reserva creada en Cal.com v2 con éxito. Booking ID: ${calBookingId}`);

    const appointmentPayload: Record<string, any> = {
        organization_id: organizationId,
        call_log_id: callLogId || null,
        customer_name: customerName,
        customer_email: customerEmail || null,
        customer_phone: customerPhone,
        start_time: startTime,
        end_time: booking.end || null,
        cal_booking_id: calBookingId,
        status: 'confirmed',
    };

    if (serviceAddress !== undefined) appointmentPayload.service_address = serviceAddress;
    if (latitude !== undefined) appointmentPayload.latitude = latitude;
    if (longitude !== undefined) appointmentPayload.longitude = longitude;

    let { data: appointment, error: dbError } = await supabaseAdmin
        .from('appointments')
        .insert(appointmentPayload)
        .select()
        .single();

    if (dbError && (dbError.message.includes('service_address') || dbError.message.includes('latitude') || dbError.message.includes('longitude'))) {
        console.warn('⚠️ Fallback en appointments: omitiendo campos de geolocalización no soportados');
        const fallbackRes = await supabaseAdmin
            .from('appointments')
            .insert({
                organization_id: organizationId,
                call_log_id: callLogId || null,
                customer_name: customerName,
                customer_email: customerEmail || null,
                customer_phone: customerPhone,
                start_time: startTime,
                end_time: booking.end || null,
                cal_booking_id: calBookingId,
                status: 'confirmed',
            })
            .select()
            .single();

        appointment = fallbackRes.data;
        dbError = fallbackRes.error;
    }

    if (dbError) {
        console.error('⚠️ Error al registrar cita en Supabase:', dbError.message);
        throw new Error(`Reserva confirmada en Cal.com v2 pero falló la inserción en Supabase: ${dbError.message}`);
    }

    return {
        appointment,
        cal_booking_id: calBookingId,
    };
}

/**
 * Reprograma una cita existente en Cal.com v2 y actualiza Supabase.
 */
export async function rescheduleBooking(params: RescheduleBookingParams) {
    const apiKey = process.env.CAL_API_KEY;
    const { appointmentId, calBookingId, newStartTime, reason } = params;

    let targetBookingId = calBookingId;

    if (!targetBookingId && appointmentId) {
        const { data } = await supabaseAdmin
            .from('appointments')
            .select('*')
            .eq('id', appointmentId)
            .maybeSingle();

        if (data) {
            targetBookingId = data.cal_booking_id;
        }
    }

    const isoStart = new Date(newStartTime).toISOString();

    if (apiKey && targetBookingId && targetBookingId !== 'cal_booking_unknown') {
        try {
            console.log(`📌 Reprogramando reserva ${targetBookingId} en Cal.com v2 a: ${isoStart}`);
            const calRes = await fetch(`${CAL_API_V2_BASE_URL}/bookings/${targetBookingId}/reschedule`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'cal-api-version': '2024-08-13',
                },
                body: JSON.stringify({
                    start: isoStart,
                    rescheduleReason: reason || 'Reprogramado por el cliente o asistente de voz',
                }),
            });

            if (!calRes.ok) {
                const errText = await calRes.text();
                console.warn(`⚠️ Advertencia Cal.com v2 POST /bookings/${targetBookingId}/reschedule (${calRes.status}):`, errText);
            }
        } catch (calErr: any) {
            console.warn('⚠️ No se pudo sincronizar la reprogramación en Cal.com:', calErr.message);
        }
    }

    const updatePayload: Record<string, any> = {
        start_time: isoStart,
        status: 'rescheduled',
    };

    let query = supabaseAdmin.from('appointments').update(updatePayload);

    if (appointmentId) {
        query = query.eq('id', appointmentId);
    } else if (targetBookingId) {
        query = query.eq('cal_booking_id', targetBookingId);
    } else {
        throw new Error('Se requiere appointmentId o calBookingId para reprogramar la cita.');
    }

    const { data: updatedAppointment, error: dbErr } = await query.select().single();

    if (dbErr) {
        throw new Error(`Error al actualizar la cita reprogramada en Supabase: ${dbErr.message}`);
    }

    return {
        appointment: updatedAppointment,
        status: 'rescheduled',
        newStartTime: isoStart,
    };
}

/**
 * Actualiza el estado de una cita en Supabase (ej: 'confirmed', 'cancelled', 'rescheduled').
 */
export async function updateAppointmentStatus(params: UpdateStatusParams) {
    const { appointmentId, calBookingId, status, reason } = params;

    let query = supabaseAdmin.from('appointments').update({
        status: status,
    });

    if (appointmentId) {
        query = query.eq('id', appointmentId);
    } else if (calBookingId) {
        query = query.eq('cal_booking_id', calBookingId);
    } else {
        throw new Error('Se requiere appointmentId o calBookingId para actualizar el estado de la cita.');
    }

    const { data, error } = await query.select().single();

    if (error) {
        throw new Error(`Error al actualizar el estado de la cita en Supabase: ${error.message}`);
    }

    if (status === 'cancelled' && data?.cal_booking_id && process.env.CAL_API_KEY) {
        try {
            await fetch(`${CAL_API_V2_BASE_URL}/bookings/${data.cal_booking_id}/cancel`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.CAL_API_KEY}`,
                    'cal-api-version': '2024-08-13',
                },
                body: JSON.stringify({
                    cancellationReason: reason || 'Cancelado por el cliente o asistente de voz',
                }),
            });
        } catch (err: any) {
            console.warn('⚠️ No se pudo cancelar directamente en Cal.com v2:', err.message);
        }
    }

    return data;
}

/**
 * Función auxiliar para procesar llamadas a herramientas de calendario desde agentes de voz Vapi AI.
 */
export async function handleCalendarToolCall(toolName: string, args: any): Promise<string> {
    const normalizedName = (toolName || '').trim();

    if (
        normalizedName === 'checkAvailability' ||
        normalizedName === 'getAvailableSlots' ||
        normalizedName === 'check_availability'
    ) {
        const eventTypeId = args.eventTypeId;
        const startTime = args.start || args.startTime;
        const endTime = args.end || args.endTime;
        const timeZone = args.timeZone || 'America/Mexico_City';

        if (!eventTypeId || !startTime || !endTime) {
            return 'Faltan parámetros requeridos para consultar disponibilidad (eventTypeId, start/startTime, end/endTime).';
        }

        const slots = await getAvailableSlots(
            Number(eventTypeId),
            String(startTime),
            String(endTime),
            String(timeZone)
        );

        if (!slots || slots.length === 0) {
            return 'No se encontraron horarios disponibles para la fecha y rango solicitados.';
        }

        const timesList = slots.slice(0, 8).map((s) => s.time).join(', ');
        return `Horarios disponibles encontrados (${slots.length}): ${timesList}`;
    }

    if (
        normalizedName === 'bookAppointment' ||
        normalizedName === 'createBooking' ||
        normalizedName === 'book_appointment'
    ) {
        const {
            organizationId,
            callLogId,
            eventTypeId,
            customerName,
            customerEmail,
            customerPhone,
            startTime = args.start,
            timeZone = 'America/Mexico_City',
            serviceAddress = args.serviceAddress || args.address,
            latitude = args.latitude,
            longitude = args.longitude,
        } = args || {};

        if (!organizationId || !eventTypeId || !customerName || !customerPhone || !startTime) {
            return 'Faltan datos obligatorios para agendar la cita (organizationId, eventTypeId, customerName, customerPhone, startTime).';
        }

        const result = await createBooking({
            organizationId: String(organizationId),
            callLogId: callLogId ? String(callLogId) : undefined,
            eventTypeId: Number(eventTypeId),
            customerName: String(customerName),
            customerEmail: customerEmail ? String(customerEmail) : undefined,
            customerPhone: String(customerPhone),
            startTime: String(startTime),
            timeZone: String(timeZone),
            serviceAddress: serviceAddress ? String(serviceAddress) : undefined,
            latitude: latitude !== undefined ? Number(latitude) : undefined,
            longitude: longitude !== undefined ? Number(longitude) : undefined,
        });

        return `Cita agendada correctamente. ID de reserva: ${result.cal_booking_id} para ${customerName} a las ${startTime}.`;
    }

    if (
        normalizedName === 'rescheduleAppointment' ||
        normalizedName === 'modifyAppointment' ||
        normalizedName === 'updateAppointment' ||
        normalizedName === 'changeAppointment'
    ) {
        const { appointmentId, calBookingId, newStartTime = args.startTime || args.start, reason } = args || {};

        if (!newStartTime || (!appointmentId && !calBookingId)) {
            return 'Falta la nueva fecha/hora (newStartTime) o el identificador de la cita para modificarla.';
        }

        const result = await rescheduleBooking({
            appointmentId: appointmentId ? String(appointmentId) : undefined,
            calBookingId: calBookingId ? String(calBookingId) : undefined,
            newStartTime: String(newStartTime),
            reason: reason ? String(reason) : undefined,
        });

        return `Cita reprogramada exitosamente para la nueva fecha: ${result.newStartTime}.`;
    }

    if (
        normalizedName === 'confirmAppointment' ||
        normalizedName === 'confirm_appointment'
    ) {
        const { appointmentId, calBookingId, status = 'confirmed', reason } = args || {};

        if (!appointmentId && !calBookingId) {
            return 'Se requiere el ID de la cita para confirmar su estado.';
        }

        const updated = await updateAppointmentStatus({
            appointmentId: appointmentId ? String(appointmentId) : undefined,
            calBookingId: calBookingId ? String(calBookingId) : undefined,
            status: String(status),
            reason: reason ? String(reason) : undefined,
        });

        return `El estado de la cita ha sido actualizado a '${updated.status}' exitosamente.`;
    }

    if (
        normalizedName === 'cancelAppointment' ||
        normalizedName === 'cancel_appointment'
    ) {
        const { appointmentId, calBookingId, reason } = args || {};

        if (!appointmentId && !calBookingId) {
            return 'Se requiere el ID de la cita para cancelarla.';
        }

        await updateAppointmentStatus({
            appointmentId: appointmentId ? String(appointmentId) : undefined,
            calBookingId: calBookingId ? String(calBookingId) : undefined,
            status: 'cancelled',
            reason: reason ? String(reason) : undefined,
        });

        return `La cita ha sido cancelada correctamente.`;
    }

    return `Herramienta de calendario '${toolName}' no reconocida.`;
}
