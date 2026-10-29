/**
 * Claves permitidas por el CHECK constraint de `quotations.origin`
 * (`db/migrations/77_quotations.sql`).
 */
export const QUOTATION_ORIGINS = {
    AGENTE: 'agente',
    DASHBOARD: 'dashboard',
    REVISION: 'revision',
} as const;

export type QuotationOrigin = (typeof QUOTATION_ORIGINS)[keyof typeof QUOTATION_ORIGINS];

export const ALL_QUOTATION_ORIGINS: readonly QuotationOrigin[] = Object.values(QUOTATION_ORIGINS);

export function isQuotationOrigin(value: string): value is QuotationOrigin {
    return (ALL_QUOTATION_ORIGINS as readonly string[]).includes(value);
}
