import { FastifyInstance } from 'fastify';
import { getSecret } from './secret-service.js';
import { SECRET_KEYS } from '../types/secret-keys.js';

const CAL_API_V2_BASE_URL = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';

export class CalCredentialsMissingError extends Error {
    constructor(organizationId: string) {
        super(`La organización ${organizationId} no tiene configurado cal_api_key en organization_secrets`);
        this.name = 'CalCredentialsMissingError';
    }
}

export class CalProviderError extends Error {
    constructor(
        public readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'CalProviderError';
    }
}

export interface CalSlot {
    time: string;
}

export interface GetAvailableSlotsParams {
    eventTypeId: number;
    startTime: string;
    endTime: string;
    timeZone?: string;
}

export interface CreateCalBookingParams {
    eventTypeId: number;
    customerName: string;
    customerEmail: string | null;
    // Opcional: el canal web chat puede no tener teléfono del visitante. La
    // ruta de negocio (routes/tools/booking.ts) ya garantiza que al menos uno
    // de los dos (teléfono/correo) llegue no-nulo antes de invocar esto.
    customerPhone: string | null;
    startTime: string;
    timeZone?: string;
}

export interface CalBookingResult {
    calBookingId: string;
    startTime: string;
    endTime: string | null;
}

export interface RescheduleCalBookingParams {
    calBookingId: string;
    newStartTime: string;
    reason?: string;
}

interface CachedSlots {
    slots: CalSlot[];
    expiresAt: number;
}

// Disponibilidad cacheada por tenant con TTL corto (AGENTS.md, Fase 5.2):
// el calendario cambia poco en 20s y evita saturar a Cal.com si el agente
// repregunta disponibilidad varias veces en la misma llamada.
const AVAILABILITY_CACHE_TTL_MS = 20 * 1000;
const availabilityCache = new Map<string, CachedSlots>();

async function resolveApiKey(organizationId: string): Promise<string> {
    const apiKey = await getSecret(organizationId, SECRET_KEYS.CAL_API_KEY);
    if (!apiKey) {
        throw new CalCredentialsMissingError(organizationId);
    }
    return apiKey;
}

function calHeaders(apiKey: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'cal-api-version': CAL_API_VERSION,
    };
}

/**
 * Consulta horarios disponibles en Cal.com v2. Nunca lanza por una respuesta
 * no-2xx del proveedor de forma directa al llamador de negocio: envuelve el
 * error en `CalProviderError` para que la ruta decida la degradación
 * verbalizable (AGENTS.md, Fase 5.1).
 */
export async function getAvailableSlots(
    fastify: FastifyInstance,
    organizationId: string,
    params: GetAvailableSlotsParams,
    signal: AbortSignal
): Promise<CalSlot[]> {
    const timeZone = params.timeZone || 'America/Mexico_City';
    const cacheKey = `${organizationId}:${params.eventTypeId}:${params.startTime}:${params.endTime}:${timeZone}`;
    const now = Date.now();
    const cached = availabilityCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        return cached.slots;
    }

    const apiKey = await resolveApiKey(organizationId);

    const url = new URL(`${CAL_API_V2_BASE_URL}/slots/available`);
    url.searchParams.set('eventTypeId', String(params.eventTypeId));
    url.searchParams.set('startTime', params.startTime);
    url.searchParams.set('endTime', params.endTime);
    url.searchParams.set('timeZone', timeZone);

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: calHeaders(apiKey),
        signal,
    });

    if (!response.ok) {
        const errText = await response.text();
        fastify.log.warn({ organizationId, status: response.status, msg: 'Cal.com respondió error en /slots/available' });
        throw new CalProviderError(response.status, errText);
    }

    const json = (await response.json()) as any;
    const rawSlots = json?.data?.slots ?? json?.data ?? json?.slots ?? {};
    const slots: CalSlot[] = [];

    if (Array.isArray(rawSlots)) {
        for (const slot of rawSlots) {
            const time = typeof slot === 'string' ? slot : slot?.start || slot?.time;
            if (time) slots.push({ time });
        }
    } else if (rawSlots && typeof rawSlots === 'object') {
        for (const dateKey of Object.keys(rawSlots)) {
            const daySlots = rawSlots[dateKey];
            if (!Array.isArray(daySlots)) continue;
            for (const slot of daySlots) {
                const time = typeof slot === 'string' ? slot : slot?.start || slot?.time;
                if (time) slots.push({ time });
            }
        }
    }

    availabilityCache.set(cacheKey, { slots, expiresAt: now + AVAILABILITY_CACHE_TTL_MS });
    return slots;
}

/**
 * Crea una reserva en Cal.com v2. No toca Supabase — la ruta de negocio
 * decide cómo y dónde persistir el resultado (separación servicio/ruta,
 * AGENTS.md §1).
 */
export async function createBooking(
    fastify: FastifyInstance,
    organizationId: string,
    params: CreateCalBookingParams,
    signal: AbortSignal
): Promise<CalBookingResult> {
    const apiKey = await resolveApiKey(organizationId);
    const timeZone = params.timeZone || 'America/Mexico_City';

    const bodyPayload = {
        start: params.startTime,
        eventTypeId: params.eventTypeId,
        attendee: {
            name: params.customerName,
            email: params.customerEmail || 'sin-correo@datagol.net',
            timeZone,
            language: 'es',
        },
        // `attendeePhoneNumber` es el slug real del campo de teléfono en el
        // formulario de reserva de Cal.com v2 (campo de sistema, no "phone").
        // Se omite por completo si no hay teléfono (canal web chat sin
        // teléfono, solo correo) — es un campo opcional en Cal.com.
        // `location` se omite a propósito: su valor válido depende de cómo
        // esté configurado el event type en Cal.com (attendeeAddress, phone,
        // etc.) y enviar un valor fijo que no coincida con esa configuración
        // hace que Cal.com rechace la reserva completa.
        ...(params.customerPhone ? { bookingFieldsResponses: { attendeePhoneNumber: params.customerPhone } } : {}),
    };

    const response = await fetch(`${CAL_API_V2_BASE_URL}/bookings`, {
        method: 'POST',
        headers: calHeaders(apiKey),
        body: JSON.stringify(bodyPayload),
        signal,
    });

    if (!response.ok) {
        const errText = await response.text();
        fastify.log.warn({ organizationId, status: response.status, msg: 'Cal.com respondió error en POST /bookings' });
        throw new CalProviderError(response.status, errText);
    }

    const calData = (await response.json()) as any;
    const booking = calData?.data ?? calData?.booking ?? calData;

    return {
        calBookingId: String(booking?.uid ?? booking?.id ?? ''),
        startTime: booking?.start ?? params.startTime,
        endTime: booking?.end ?? null,
    };
}

/**
 * Reprograma una reserva existente en Cal.com v2.
 */
export async function rescheduleBooking(
    fastify: FastifyInstance,
    organizationId: string,
    params: RescheduleCalBookingParams,
    signal: AbortSignal
): Promise<CalBookingResult> {
    const apiKey = await resolveApiKey(organizationId);

    const response = await fetch(`${CAL_API_V2_BASE_URL}/bookings/${params.calBookingId}/reschedule`, {
        method: 'POST',
        headers: calHeaders(apiKey),
        body: JSON.stringify({
            start: params.newStartTime,
            // Cal.com v2 rechaza `rescheduleReason` con 400 ("property should
            // not exist") — el nombre real del campo es `reschedulingReason`,
            // verificado contra la API real (no está claro en la doc pública).
            reschedulingReason: params.reason || 'Reprogramado por el cliente durante la llamada',
        }),
        signal,
    });

    if (!response.ok) {
        const errText = await response.text();
        fastify.log.warn({ organizationId, status: response.status, msg: 'Cal.com respondió error en /bookings/:id/reschedule' });
        throw new CalProviderError(response.status, errText);
    }

    const calData = (await response.json()) as any;
    const booking = calData?.data ?? calData?.booking ?? calData;

    return {
        calBookingId: String(booking?.uid ?? booking?.id ?? params.calBookingId),
        startTime: booking?.start ?? params.newStartTime,
        endTime: booking?.end ?? null,
    };
}

/**
 * Cancela una reserva existente en Cal.com v2.
 */
export async function cancelBooking(
    fastify: FastifyInstance,
    organizationId: string,
    calBookingId: string,
    reason: string | undefined,
    signal: AbortSignal
): Promise<void> {
    const apiKey = await resolveApiKey(organizationId);

    const response = await fetch(`${CAL_API_V2_BASE_URL}/bookings/${calBookingId}/cancel`, {
        method: 'POST',
        headers: calHeaders(apiKey),
        body: JSON.stringify({ cancellationReason: reason || 'Cancelado por el cliente o asistente de voz' }),
        signal,
    });

    if (!response.ok) {
        const errText = await response.text();
        fastify.log.warn({ organizationId, status: response.status, msg: 'Cal.com respondió error en /bookings/:id/cancel' });
        throw new CalProviderError(response.status, errText);
    }
}

export interface CalBookingStatus {
    calBookingId: string;
    /** Valores documentados de Cal.com v2 (GET /v2/bookings/{uid}): accepted, pending, cancelled, rejected. */
    status: string;
}

/**
 * Consulta el estado actual de una reserva en Cal.com v2
 * (docs/tasks/asistencia-valor de cierre.md, B.2) — permite detectar
 * cancelaciones que el cliente hizo directamente en Cal.com, fuera del
 * flujo del agente de voz. Cal.com también expone `attendees[].absent`,
 * pero es una marca manual de su propio lado (vía un endpoint aparte de
 * "mark no-show"), no un dato de asistencia real automático — no se usa
 * aquí, la asistencia sigue siendo 100% manual en nuestro propio sistema
 * (B.1).
 */
export async function getBooking(
    fastify: FastifyInstance,
    organizationId: string,
    calBookingId: string,
    signal: AbortSignal
): Promise<CalBookingStatus> {
    const apiKey = await resolveApiKey(organizationId);

    const response = await fetch(`${CAL_API_V2_BASE_URL}/bookings/${calBookingId}`, {
        method: 'GET',
        headers: calHeaders(apiKey),
        signal,
    });

    if (!response.ok) {
        const errText = await response.text();
        fastify.log.warn({ organizationId, calBookingId, status: response.status, msg: 'Cal.com respondió error en GET /bookings/:id' });
        throw new CalProviderError(response.status, errText);
    }

    const json = (await response.json()) as any;
    const booking = json?.data ?? json;

    return {
        calBookingId: String(booking?.uid ?? booking?.id ?? calBookingId),
        status: String(booking?.status ?? ''),
    };
}

/**
 * Invalida la caché de disponibilidad en memoria. Se expone para pruebas.
 */
export function invalidateAvailabilityCache(): void {
    availabilityCache.clear();
}
