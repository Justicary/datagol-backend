/**
 * Claves permitidas por el CHECK constraint de `quotations.status`
 * (`db/migrations/77_quotations.sql`).
 */
export const QUOTATION_STATUSES = {
    BORRADOR: 'borrador',
    ABANDONADA: 'abandonada',
    EMITIDA: 'emitida',
    ENVIADA: 'enviada',
    ACEPTADA: 'aceptada',
    RECHAZADA: 'rechazada',
    VENCIDA: 'vencida',
    CANCELADA: 'cancelada',
    CONVERTIDA: 'convertida',
} as const;

export type QuotationStatus = (typeof QUOTATION_STATUSES)[keyof typeof QUOTATION_STATUSES];

export const ALL_QUOTATION_STATUSES: readonly QuotationStatus[] = Object.values(QUOTATION_STATUSES);

export function isQuotationStatus(value: string): value is QuotationStatus {
    return (ALL_QUOTATION_STATUSES as readonly string[]).includes(value);
}
