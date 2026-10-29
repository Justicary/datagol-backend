/**
 * Claves permitidas por el CHECK constraint de `quotation_events.event_type`
 * (`db/migrations/77_quotations.sql`).
 */
export const QUOTATION_EVENT_TYPES = {
    CARRITO_CREADO: 'carrito_creado',
    CARRITO_RETOMADO: 'carrito_retomado',
    PARTIDA_AGREGADA: 'partida_agregada',
    CANTIDAD_CAMBIADA: 'cantidad_cambiada',
    PARTIDA_ELIMINADA: 'partida_eliminada',
    EMITIDA: 'emitida',
    PRECIO_CAMBIADO_AL_EMITIR: 'precio_cambiado_al_emitir',
    PDF_GENERADO: 'pdf_generado',
    ENVIADA: 'enviada',
    ENVIO_FALLIDO: 'envio_fallido',
    ACEPTADA: 'aceptada',
    RECHAZADA: 'rechazada',
    VENCIDA: 'vencida',
    CANCELADA: 'cancelada',
    REVISADA: 'revisada',
    EXPORTADA: 'exportada',
    ABANDONADA: 'abandonada',
} as const;

export type QuotationEventType = (typeof QUOTATION_EVENT_TYPES)[keyof typeof QUOTATION_EVENT_TYPES];

export const ALL_QUOTATION_EVENT_TYPES: readonly QuotationEventType[] = Object.values(QUOTATION_EVENT_TYPES);

export function isQuotationEventType(value: string): value is QuotationEventType {
    return (ALL_QUOTATION_EVENT_TYPES as readonly string[]).includes(value);
}
