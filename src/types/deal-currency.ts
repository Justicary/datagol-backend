/**
 * Valores permitidos por el CHECK constraint de `contacts.deal_currency`
 * (db/migrations/39_resultado_negocio.sql). Única fuente de verdad — mismo
 * patrón que `secret-keys.ts`.
 *
 * Verificado por inserción directa contra la base real — ver
 * __tests__/deal-currency.test.ts.
 */
export const DEAL_CURRENCIES = {
    MXN: 'MXN',
    USD: 'USD',
} as const;

export type DealCurrency = (typeof DEAL_CURRENCIES)[keyof typeof DEAL_CURRENCIES];

export const ALL_DEAL_CURRENCIES: readonly DealCurrency[] = Object.values(DEAL_CURRENCIES);

export function isDealCurrency(value: string): value is DealCurrency {
    return (ALL_DEAL_CURRENCIES as readonly string[]).includes(value);
}
