import { z } from 'zod';

/**
 * Esquemas Zod de `routes/tools/**` (camino crítico de voz, AGENTS.md §3 y
 * Fase 5 de docs/tasks/backend-implementation.md). Deliberadamente laxos en
 * el formato exacto de fecha/hora: el remitente es el LLM del agente de voz,
 * no un cliente HTTP estricto, y rechazar por formato en vez de intentar
 * `new Date()` cuesta una llamada perdida. La validez real de la fecha se
 * verifica aparte con `Number.isNaN(new Date(x).getTime())`.
 */
export const toolParamsSchema = z.object({
    webhookToken: z.string().min(1),
});
export type ToolParams = z.infer<typeof toolParamsSchema>;

export const availabilityBodySchema = z.object({
    startTime: z.string().min(1),
    endTime: z.string().min(1),
    timeZone: z.string().min(1).optional(),
});
export type AvailabilityBody = z.infer<typeof availabilityBodySchema>;

export const availabilityResponseSchema = z.object({
    available: z.boolean(),
    slots: z.array(z.string()).max(2),
    message: z.string(),
});
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;

// El agente de voz/chat manda `""` para un campo opcional que el cliente no
// proporcionó (no lo omite del payload) — sin este preprocesamiento,
// `customerEmail: ""` rompe `.email()` con un 400 genérico que nunca llega a
// la validación de negocio de más abajo ("necesito teléfono o correo").
const emptyStringToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

export const bookingBodySchema = z.object({
    conversationId: z.string().min(1),
    customerName: z.string().min(1),
    // Ninguno de los dos es individualmente obligatorio: el canal web chat
    // puede no tener teléfono. La ruta exige al menos uno de los dos — ver
    // routes/tools/booking.ts — con un mensaje verbalizable, no un 400 mudo.
    customerPhone: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
    customerEmail: z.preprocess(emptyStringToUndefined, z.string().email().optional()),
    startTime: z.string().min(1),
    timeZone: z.string().min(1).optional(),
    // Fase C (docs/tasks/opus.md): si el agente ya confirmó con el cliente
    // que reutiliza la dirección propuesta (ver `proposedAddress` de
    // GET.../booking anterior o de este mismo intento), manda su id en vez
    // de dictarla de nuevo.
    contactAddressId: z.preprocess(emptyStringToUndefined, z.string().uuid().optional()),
    // Dirección nueva dictada por el cliente en esta llamada (no coincide
    // con la propuesta, o el contacto no tenía ninguna en archivo). Texto
    // libre: se resuelve/consolida vía resolve_contact_address.
    serviceAddress: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
});
export type BookingBody = z.infer<typeof bookingBodySchema>;

const proposedAddressSchema = z.object({
    addressId: z.string(),
    street: z.string(),
    neighborhood: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    postalCode: z.string().nullable(),
});
export type ProposedAddress = z.infer<typeof proposedAddressSchema>;

export const bookingResponseSchema = z.object({
    booked: z.boolean(),
    message: z.string(),
    startTime: z.string().nullish(),
    appointmentId: z.string().nullish(),
    // Solo poblado cuando el llamador NO mandó contactAddressId/serviceAddress
    // y el contacto ya tiene una dirección principal en archivo (Fase C): el
    // agente puede proponerla ("¿confirmas que es en Av. Reforma 123?") en
    // vez de pedirla de cero.
    proposedAddress: proposedAddressSchema.nullish(),
});
export type BookingResponse = z.infer<typeof bookingResponseSchema>;

export const rescheduleBodySchema = z.object({
    customerName: z.string().min(1),
    // Mismo criterio que bookingBodySchema: la cita original pudo haberse
    // creado solo con teléfono (sin correo) si vino de un canal sin correo.
    // La ruta exige al menos uno de los dos para poder ubicarla.
    customerEmail: z.preprocess(emptyStringToUndefined, z.string().email().optional()),
    customerPhone: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
    newStartTime: z.string().min(1),
    timeZone: z.string().min(1).optional(),
});
export type RescheduleBody = z.infer<typeof rescheduleBodySchema>;

export const rescheduleResponseSchema = z.object({
    rescheduled: z.boolean(),
    message: z.string(),
    newStartTime: z.string().nullish(),
});
export type RescheduleResponse = z.infer<typeof rescheduleResponseSchema>;

export const cancelBodySchema = z.object({
    customerName: z.string().min(1),
    // Mismo criterio que rescheduleBodySchema: la cita original pudo haberse
    // creado solo con teléfono o solo con correo. La ruta exige al menos uno
    // de los dos para poder ubicarla con seguridad.
    customerEmail: z.preprocess(emptyStringToUndefined, z.string().email().optional()),
    customerPhone: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
    // Motivo de cancelación proporcionado por el cliente durante la llamada.
    reason: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
});
export type CancelBody = z.infer<typeof cancelBodySchema>;

export const cancelResponseSchema = z.object({
    cancelled: z.boolean(),
    message: z.string(),
});
export type CancelResponse = z.infer<typeof cancelResponseSchema>;

export const locationItemSchema = z.object({
    id: z.string().uuid(),
    label: z.string().nullable(),
    addressType: z.string(),
    isPrimary: z.boolean(),
    street: z.string(),
    interior: z.string().nullable(),
    neighborhood: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    postalCode: z.string().nullable(),
    country: z.string(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    fullAddress: z.string(),
    notes: z.string().nullable(),
});
export type LocationItem = z.infer<typeof locationItemSchema>;

export const locationsBodySchema = z.object({
    addressType: z.preprocess(emptyStringToUndefined, z.enum(['matriz', 'sucursal', 'facturacion', 'domicilio', 'servicio']).optional()),
    label: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
});
export type LocationsBody = z.infer<typeof locationsBodySchema>;

export const locationsResponseSchema = z.object({
    locations: z.array(locationItemSchema),
    primaryLocation: locationItemSchema.nullable(),
    message: z.string(),
});
export type LocationsResponse = z.infer<typeof locationsResponseSchema>;

export function isValidDateString(value: string): boolean {
    return !Number.isNaN(new Date(value).getTime());
}
