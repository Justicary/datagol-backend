import { z } from 'zod';
import { CATALOG_IMPORT_MODES } from '../types/catalog-import.js';

export const catalogOrgParamsSchema = z.object({ id: z.string().uuid() });
export const catalogParamsSchema = z.object({ id: z.string().uuid(), catalogId: z.string().uuid() });
export const productParamsSchema = z.object({ id: z.string().uuid(), catalogId: z.string().uuid(), productId: z.string().uuid() });

const productImageEntrySchema = z.object({
    imageUrl: z.string().nullable(),
    mimeType: z.string().nullable(),
    sizeBytes: z.number().nullable(),
    uploadedAt: z.string().nullable(),
});

export const productImageResponseSchema = z.object({
    success: z.literal(true),
    data: productImageEntrySchema,
});

/** Tope duro de `POST .../products/images/batch` — firma solo lo visible, nunca el catálogo completo de una vez. */
export const MAX_BATCH_IMAGE_PRODUCT_IDS = 100;

export const batchProductImagesBodySchema = z.object({
    productIds: z.array(z.string().uuid()).min(1).max(MAX_BATCH_IMAGE_PRODUCT_IDS),
});
export type BatchProductImagesBody = z.infer<typeof batchProductImagesBodySchema>;

export const batchProductImagesResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        images: z.record(z.string(), productImageEntrySchema),
    }),
});

export const createCatalogBodySchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
});
export type CreateCatalogBody = z.infer<typeof createCatalogBodySchema>;

/**
 * Organizaciones hermanas del mismo grupo de credenciales — para elegir con
 * quién compartir un catálogo o a cuál fijarle un override de precio. La RLS
 * de `organizations` (`org_read`, migración 45) solo deja ver las propias
 * organizaciones activas, así que un admin/owner normal no puede hacer un
 * SELECT directo y listar a sus hermanas; de ahí este endpoint dedicado
 * (GET .../credential-group/organizations, supabaseAdmin + verificación
 * explícita de permiso y pertenencia, AGENTS.md §16).
 */
export const credentialGroupOrganizationsResponseSchema = z.object({
    success: z.literal(true),
    data: z.array(z.object({ id: z.string(), name: z.string() })),
});

export const shareCatalogBodySchema = z.object({
    organizationId: z.string().uuid(),
    canEdit: z.boolean().optional().default(false),
});
export type ShareCatalogBody = z.infer<typeof shareCatalogBodySchema>;

/**
 * Mapeo de columnas configurable (FASE E): cada clave canónica apunta al
 * encabezado real que trae el archivo del cliente. `sku` es obligatorio en
 * ambos modos; el resto depende del modo (ver catalog-import-service.ts:
 * `REQUIRED_FIELDS_BY_MODE`).
 */
export const columnMappingSchema = z.object({
    sku: z.string().min(1),
    name: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    activeComponents: z.string().min(1).optional(),
    suggestedUse: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    contraindications: z.string().min(1).optional(),
    presentation: z.string().min(1).optional(),
    price: z.string().min(1).optional(),
    stockStatus: z.string().min(1).optional(),
    stockNote: z.string().min(1).optional(),
    imageUrl: z.string().min(1).optional(),
});
export type ColumnMapping = z.infer<typeof columnMappingSchema>;

export const importRequestFieldsSchema = z.object({
    mode: z.enum([CATALOG_IMPORT_MODES.COMPLETO, CATALOG_IMPORT_MODES.SOLO_PRECIOS]).default(CATALOG_IMPORT_MODES.COMPLETO),
    columnMapping: columnMappingSchema,
});

/**
 * Paso previo al mapeo de columnas (wizard de importación, frontend): el
 * usuario necesita ver los encabezados y filas de ejemplo del archivo ANTES
 * de poder armar `columnMapping` — problema de huevo y gallina que
 * `/import/preview` no resuelve porque exige el mapeo ya armado. Solo
 * inspecciona, nunca calcula altas/cambios/errores (eso sigue siendo
 * exclusivo de preview/apply).
 */
export const importInspectResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        headers: z.array(z.string()),
        sampleRows: z.array(z.record(z.string(), z.string())),
        totalRows: z.number(),
    }),
});

export const importRowErrorSchema = z.object({
    row: z.number(),
    message: z.string(),
});

export const importPreviewResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        totalRows: z.number(),
        toCreate: z.number(),
        toUpdate: z.number(),
        errors: z.array(importRowErrorSchema),
        duplicateSkusInFile: z.array(z.string()),
        // Separado de `errors`: una imagen que no se pudo descargar/validar
        // NUNCA invalida la fila (el producto igual se cuenta en
        // toCreate/toUpdate). La vista previa no descarga imágenes, así que
        // siempre llega vacío — existe para que el shape sea idéntico al de
        // /import y el frontend no distinga entre ambos.
        imageErrors: z.array(importRowErrorSchema),
    }),
});

export const importApplyResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        importId: z.string(),
        status: z.string(),
        rowsTotal: z.number(),
        rowsCreated: z.number(),
        rowsUpdated: z.number(),
        rowsFailed: z.number(),
        errors: z.array(importRowErrorSchema),
        // Fallos de descarga/validación de la imagen de la columna opcional
        // `imageUrl` — la fila igual se crea/actualiza; ver catalog-import-service.ts.
        imageErrors: z.array(importRowErrorSchema),
    }),
});

export const listImportsResponseSchema = z.object({
    success: z.literal(true),
    data: z.array(
        z.object({
            id: z.string(),
            fileName: z.string().nullable(),
            mode: z.string(),
            status: z.string(),
            rowsTotal: z.number(),
            rowsCreated: z.number(),
            rowsUpdated: z.number(),
            rowsFailed: z.number(),
            createdAt: z.string(),
            completedAt: z.string().nullable(),
        })
    ),
});

/**
 * Mapeos de columnas guardados (reutilizables) — `catalog_import_mappings`,
 * db/migrations/61_catalog_import_mappings.sql. Un cliente trae siempre el
 * mismo formato de archivo mes a mes; guardar el mapeo evita repetir el paso
 * manual en cada importación.
 */
export const createImportMappingBodySchema = z.object({
    name: z.string().min(1),
    mode: z.enum([CATALOG_IMPORT_MODES.COMPLETO, CATALOG_IMPORT_MODES.SOLO_PRECIOS]),
    columnMapping: columnMappingSchema,
});
export type CreateImportMappingBody = z.infer<typeof createImportMappingBodySchema>;

export const importMappingResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        id: z.string(),
        name: z.string(),
        mode: z.string(),
        columnMapping: columnMappingSchema,
        createdAt: z.string(),
    }),
});

export const listImportMappingsResponseSchema = z.object({
    success: z.literal(true),
    data: z.array(
        z.object({
            id: z.string(),
            name: z.string(),
            mode: z.string(),
            columnMapping: columnMappingSchema,
            createdAt: z.string(),
        })
    ),
});
