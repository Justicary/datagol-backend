/**
 * Claves permitidas por los CHECK constraints de `catalog_imports.mode` y
 * `catalog_imports.status` (`db/migrations/56_catalogo_productos.sql`
 * BLOQUE 9). Única fuente de verdad: ningún literal de modo o estado de
 * importación debe escribirse en otro lugar del código.
 *
 * Verificado por inserción directa contra la base real — ver
 * __tests__/catalog-enums.test.ts.
 */
export const CATALOG_IMPORT_MODES = {
    COMPLETO: 'completo',
    // Archivo de dos columnas (SKU, precio). No toca la capa descriptiva y
    // NO dispara resincronización de la KB — ver services/catalog-import-service.ts.
    SOLO_PRECIOS: 'solo_precios',
} as const;

export type CatalogImportMode = (typeof CATALOG_IMPORT_MODES)[keyof typeof CATALOG_IMPORT_MODES];

export const ALL_CATALOG_IMPORT_MODES: readonly CatalogImportMode[] = Object.values(CATALOG_IMPORT_MODES);

export function isCatalogImportMode(value: string): value is CatalogImportMode {
    return (ALL_CATALOG_IMPORT_MODES as readonly string[]).includes(value);
}

export const CATALOG_IMPORT_STATUSES = {
    PROCESANDO: 'procesando',
    COMPLETADO: 'completado',
    FALLIDO: 'fallido',
    REVERTIDO: 'revertido',
} as const;

export type CatalogImportStatus = (typeof CATALOG_IMPORT_STATUSES)[keyof typeof CATALOG_IMPORT_STATUSES];

export const ALL_CATALOG_IMPORT_STATUSES: readonly CatalogImportStatus[] = Object.values(CATALOG_IMPORT_STATUSES);

export function isCatalogImportStatus(value: string): value is CatalogImportStatus {
    return (ALL_CATALOG_IMPORT_STATUSES as readonly string[]).includes(value);
}
