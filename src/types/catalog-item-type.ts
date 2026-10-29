/**
 * Claves permitidas por el CHECK constraint de `products.item_type` y
 * `quotation_items.item_type` (`db/migrations/76_catalog_item_types_and_plans_bridge.sql`,
 * `db/migrations/77_quotations.sql`).
 */
export const CATALOG_ITEM_TYPES = {
    PRODUCTO: 'producto',
    SERVICIO: 'servicio',
    PLAN: 'plan',
} as const;

export type CatalogItemType = (typeof CATALOG_ITEM_TYPES)[keyof typeof CATALOG_ITEM_TYPES];

export const ALL_CATALOG_ITEM_TYPES: readonly CatalogItemType[] = Object.values(CATALOG_ITEM_TYPES);

export function isCatalogItemType(value: string): value is CatalogItemType {
    return (ALL_CATALOG_ITEM_TYPES as readonly string[]).includes(value);
}
