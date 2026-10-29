/**
 * Claves permitidas por el CHECK constraint de `deployments.billing_period`
 * (`db/migrations/55_control_plane_datagol.sql`), `product_variants.billing_period`
 * (`db/migrations/76_catalog_item_types_and_plans_bridge.sql`) y
 * `quotation_items.billing_period` (`db/migrations/77_quotations.sql`).
 */
export const BILLING_PERIODS = {
    UNICO: 'unico',
    MENSUAL: 'mensual',
    ANUAL: 'anual',
} as const;

export type BillingPeriod = (typeof BILLING_PERIODS)[keyof typeof BILLING_PERIODS];

export const ALL_BILLING_PERIODS: readonly BillingPeriod[] = Object.values(BILLING_PERIODS);

export function isBillingPeriod(value: string): value is BillingPeriod {
    return (ALL_BILLING_PERIODS as readonly string[]).includes(value);
}
