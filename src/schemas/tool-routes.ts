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

export const bookingBodySchema = z.object({
    conversationId: z.string().min(1),
    customerName: z.string().min(1),
    customerPhone: z.string().min(1),
    customerEmail: z.string().email().nullish(),
    startTime: z.string().min(1),
    timeZone: z.string().min(1).optional(),
});
export type BookingBody = z.infer<typeof bookingBodySchema>;

export const bookingResponseSchema = z.object({
    booked: z.boolean(),
    message: z.string(),
    startTime: z.string().nullish(),
    appointmentId: z.string().nullish(),
});
export type BookingResponse = z.infer<typeof bookingResponseSchema>;

export const rescheduleBodySchema = z.object({
    customerName: z.string().min(1),
    customerEmail: z.string().email(),
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

export function isValidDateString(value: string): boolean {
    return !Number.isNaN(new Date(value).getTime());
}
