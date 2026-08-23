/**
 * Claves permitidas por el CHECK constraint de `product_kb_sync.status`
 * (`db/migrations/56_catalogo_productos.sql` BLOQUE 8). Única fuente de
 * verdad: ningún literal de estado de sincronización con la knowledge base
 * debe escribirse en otro lugar del código.
 *
 * Verificado por inserción directa contra la base real — ver
 * __tests__/catalog-enums.test.ts.
 */
export const KB_SYNC_STATUSES = {
    PENDIENTE: 'pendiente',
    SINCRONIZADO: 'sincronizado',
    ERROR: 'error',
    ELIMINADO: 'eliminado',
} as const;

export type KbSyncStatus = (typeof KB_SYNC_STATUSES)[keyof typeof KB_SYNC_STATUSES];

export const ALL_KB_SYNC_STATUSES: readonly KbSyncStatus[] = Object.values(KB_SYNC_STATUSES);

export function isKbSyncStatus(value: string): value is KbSyncStatus {
    return (ALL_KB_SYNC_STATUSES as readonly string[]).includes(value);
}
