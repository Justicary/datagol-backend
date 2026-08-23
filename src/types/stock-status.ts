/**
 * Claves permitidas por el CHECK constraint de `product_variants.stock_status`
 * y `organization_variant_overrides.stock_status` (mismo dominio,
 * `db/migrations/56_catalogo_productos.sql` BLOQUE 6/7). Única fuente de
 * verdad: ningún literal de estado de existencias debe escribirse en otro
 * lugar del código.
 *
 * Verificado por inserción directa contra la base real — ver
 * __tests__/catalog-enums.test.ts, que falla si esta lista se desincroniza
 * del constraint.
 */
export const STOCK_STATUSES = {
    DISPONIBLE: 'disponible',
    BAJO: 'bajo',
    AGOTADO: 'agotado',
    BAJO_PEDIDO: 'bajo_pedido',
    SIN_DATO: 'sin_dato',
} as const;

export type StockStatus = (typeof STOCK_STATUSES)[keyof typeof STOCK_STATUSES];

export const ALL_STOCK_STATUSES: readonly StockStatus[] = Object.values(STOCK_STATUSES);

export function isStockStatus(value: string): value is StockStatus {
    return (ALL_STOCK_STATUSES as readonly string[]).includes(value);
}

/**
 * Mapeo de `stock_status` a lenguaje hablado (docs/tasks/catalogo-productos-grupos-cred.md,
 * FASE D). Las existencias son informativas, no inventario en vivo — el
 * agente nunca afirma disponibilidad como un hecho ("sí tenemos", "hay 12
 * piezas"): siempre la matiza y ofrece confirmarla. Este es el único lugar
 * del backend que redacta esa matización; el system prompt (FASE G) la
 * refuerza, no la reemplaza.
 */
export const STOCK_STATUS_SPEECH: Record<StockStatus, string> = {
    disponible: 'Según mi información hay disponible, aunque conviene confirmarlo',
    bajo: 'Me aparece con poca existencia',
    agotado: 'Me aparece agotado',
    bajo_pedido: 'Es sobre pedido',
    sin_dato: 'No tengo la disponibilidad a la mano',
};

export function stockStatusToSpeech(value: string): string {
    return isStockStatus(value) ? STOCK_STATUS_SPEECH[value] : STOCK_STATUS_SPEECH.sin_dato;
}
