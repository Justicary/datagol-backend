import ExcelJS from 'exceljs';
import { Readable } from 'stream';
import { lookup as dnsLookup } from 'dns/promises';
import { isIP } from 'net';
import { FastifyInstance } from 'fastify';
import { ALL_STOCK_STATUSES, isStockStatus, STOCK_STATUSES } from '../types/stock-status.js';
import { CATALOG_IMPORT_MODES, type CatalogImportMode } from '../types/catalog-import.js';
import type { ColumnMapping } from '../schemas/catalog.js';
import { uploadProductImage } from './product-image-service.js';

export interface ParsedFile {
    headers: string[];
    rows: Record<string, string>[];
}

/**
 * Parsea un archivo CSV/XLSX en memoria (mismo patrón que routes/upload.ts,
 * AGENTS.md §1: CSV y XLSX se procesan en el backend, nunca en el
 * navegador). Los valores de celda se convierten a texto y se recortan —
 * el archivo del cliente nunca se procesa "tal cual" un tipo nativo de
 * ExcelJS más allá de esta función.
 */
export async function parseCatalogFile(buffer: Buffer, filename: string, mimetype: string): Promise<ParsedFile> {
    const workbook = new ExcelJS.Workbook();
    const lowerName = (filename || '').toLowerCase();
    const lowerMime = (mimetype || '').toLowerCase();

    if (lowerName.endsWith('.csv') || lowerMime.includes('csv')) {
        await workbook.csv.read(Readable.from(buffer));
    } else {
        await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    }

    const worksheet = workbook.getWorksheet(1);
    if (!worksheet) {
        return { headers: [], rows: [] };
    }

    const headers: string[] = [];
    worksheet.getRow(1).eachCell((cell, colNumber) => {
        headers[colNumber] = String(cell.value ?? '').trim();
    });

    const rows: Record<string, string>[] = [];
    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const rowData: Record<string, string> = {};
        let hasAnyValue = false;
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const header = headers[colNumber];
            if (!header) return;
            const value = cell.value === null || cell.value === undefined ? '' : String(cell.value).trim();
            rowData[header] = value;
            if (value !== '') hasAnyValue = true;
        });
        if (hasAnyValue) rows.push(rowData);
    });

    return { headers, rows };
}

/** Campos obligatorios de `columnMapping` según el modo (FASE E). */
export const REQUIRED_FIELDS_BY_MODE: Record<CatalogImportMode, (keyof ColumnMapping)[]> = {
    [CATALOG_IMPORT_MODES.COMPLETO]: ['sku', 'name'],
    [CATALOG_IMPORT_MODES.SOLO_PRECIOS]: ['sku', 'price'],
};

export function validateColumnMapping(mapping: ColumnMapping, headers: string[], mode: CatalogImportMode): string[] {
    const errors: string[] = [];
    const headerSet = new Set(headers);

    for (const field of REQUIRED_FIELDS_BY_MODE[mode]) {
        const mappedHeader = mapping[field];
        if (!mappedHeader) {
            errors.push(`El mapeo de columnas no incluye el campo obligatorio "${field}" para el modo "${mode}".`);
            continue;
        }
        if (!headerSet.has(mappedHeader)) {
            errors.push(`La columna "${mappedHeader}" mapeada a "${field}" no existe en el archivo (encabezados: ${headers.join(', ')}).`);
        }
    }

    return errors;
}

export interface ImportRowError {
    row: number;
    message: string;
}

export interface ImportPlanRow {
    row: number;
    sku: string;
    skuUpper: string;
    isUpdate: boolean;
    fields: {
        name?: string;
        category?: string;
        activeComponents?: string;
        suggestedUse?: string;
        description?: string;
        contraindications?: string;
        presentation?: string;
        price?: number;
        stockStatus?: string;
        stockNote?: string;
        imageUrl?: string;
    };
}

export interface ImportPlan {
    totalRows: number;
    toCreate: number;
    toUpdate: number;
    errors: ImportRowError[];
    duplicateSkusInFile: string[];
    validRows: ImportPlanRow[];
}

const IMAGE_DOWNLOAD_TIMEOUT_MS = 10_000;
const IMAGE_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024; // cota dura de descarga; validateImageMagicBytes aplica el tope real después

/**
 * Bloquea IPv4/IPv6 de loopback, enlace-local y rangos privados — la columna
 * `imageUrl` del archivo de importación es una URL arbitraria que aporta el
 * cliente, así que sin este filtro un archivo malicioso podría usar el
 * servidor para escanear o alcanzar servicios internos (SSRF).
 */
function isPrivateOrLoopbackIp(ip: string): boolean {
    const type = isIP(ip);
    if (type === 4) {
        const octets = ip.split('.').map(Number);
        const [a, b] = octets;
        if (a === 127 || a === 10 || a === 0) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        return false;
    }
    if (type === 6) {
        const lower = ip.toLowerCase();
        if (lower === '::1') return true;
        if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
        if (lower.startsWith('::ffff:')) return isPrivateOrLoopbackIp(lower.slice('::ffff:'.length));
        return false;
    }
    return true; // no se pudo determinar el tipo: se rechaza por seguridad
}

async function assertSafeImageUrl(rawUrl: string): Promise<void> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error(`URL de imagen inválida: "${rawUrl}".`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Esquema de URL no permitido: "${parsed.protocol}".`);
    }
    if (parsed.hostname === 'localhost') {
        throw new Error('No se permite descargar imágenes desde localhost.');
    }

    let addresses: { address: string }[];
    try {
        addresses = [await dnsLookup(parsed.hostname)];
    } catch (err) {
        throw new Error(`No se pudo resolver el dominio de la imagen: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (addresses.some((a) => isPrivateOrLoopbackIp(a.address))) {
        throw new Error('La URL de la imagen resuelve a una dirección de red interna, no permitida.');
    }
}

/**
 * Descarga una imagen de producto desde una URL externa (columna opcional
 * `imageUrl` del mapeo de importación), la valida con las mismas reglas que
 * la subida manual (`validateImageMagicBytes` vía `uploadProductImage`) y la
 * asocia al producto. Un fallo aquí NUNCA invalida la fila del import — el
 * llamador debe capturar el error y reportarlo aparte (`imageErrors`).
 */
async function downloadAndAttachProductImage(fastify: FastifyInstance, catalogId: string, productId: string, imageUrl: string): Promise<void> {
    await assertSafeImageUrl(imageUrl);

    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`La URL de la imagen respondió con estado ${response.status}.`);
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > IMAGE_DOWNLOAD_MAX_BYTES) {
        throw new Error('La imagen excede el tamaño máximo permitido.');
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > IMAGE_DOWNLOAD_MAX_BYTES) {
        throw new Error('La imagen excede el tamaño máximo permitido.');
    }
    const buffer = Buffer.from(arrayBuffer);

    const fileName = imageUrl.split('/').pop()?.split('?')[0] || 'imagen';
    await uploadProductImage(fastify, { catalogId, productId, fileName, fileBuffer: buffer });
}

function parsePrice(raw: string | undefined): number | null {
    if (raw === undefined || raw.trim() === '') return null;
    const cleaned = raw.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : null;
}

/**
 * Construye el plan de importación (altas/cambios/errores) SIN tocar la base
 * de datos — función pura para que preview y apply compartan exactamente la
 * misma lógica de conteo (FASE E: "vista previa antes de aplicar: altas,
 * cambios y errores contados").
 *
 * `existingSkusUpper` es el conjunto de SKU (en mayúsculas) que YA existen en
 * el catálogo — determina alta vs. cambio. La deduplicación DENTRO del
 * archivo (mismo SKU dos veces en el mismo upload) se detecta aquí mismo,
 * sin distinguir mayúsculas (mismo criterio que la restricción única de la
 * base, `ux_variants_sku_lookup`).
 */
export function buildImportPlan(
    rows: Record<string, string>[],
    mapping: ColumnMapping,
    mode: CatalogImportMode,
    existingSkusUpper: ReadonlySet<string>
): ImportPlan {
    const errors: ImportRowError[] = [];
    const validRows: ImportPlanRow[] = [];
    const seenInFile = new Set<string>();
    const duplicateSkusInFile = new Set<string>();
    let toCreate = 0;
    let toUpdate = 0;

    rows.forEach((row, index) => {
        const rowNumber = index + 2; // fila 1 es encabezado
        const skuRaw = (row[mapping.sku] ?? '').trim();

        if (!skuRaw) {
            errors.push({ row: rowNumber, message: 'Falta el SKU.' });
            return;
        }
        const skuUpper = skuRaw.toUpperCase();

        if (seenInFile.has(skuUpper)) {
            duplicateSkusInFile.add(skuUpper);
            errors.push({ row: rowNumber, message: `SKU duplicado dentro del archivo: "${skuRaw}".` });
            return;
        }
        seenInFile.add(skuUpper);

        const isUpdate = existingSkusUpper.has(skuUpper);

        if (mode === CATALOG_IMPORT_MODES.SOLO_PRECIOS) {
            if (!isUpdate) {
                errors.push({ row: rowNumber, message: `SKU "${skuRaw}" no existe en el catálogo — el modo solo_precios no crea productos nuevos.` });
                return;
            }
            const price = parsePrice(row[mapping.price!]);
            if (price === null) {
                errors.push({ row: rowNumber, message: `Precio inválido para el SKU "${skuRaw}".` });
                return;
            }
            validRows.push({ row: rowNumber, sku: skuRaw, skuUpper, isUpdate: true, fields: { price } });
            toUpdate++;
            return;
        }

        const name = (row[mapping.name!] ?? '').trim();
        if (!name) {
            errors.push({ row: rowNumber, message: `Falta el nombre del producto para el SKU "${skuRaw}".` });
            return;
        }

        const stockStatusRaw = mapping.stockStatus ? (row[mapping.stockStatus] ?? '').trim().toLowerCase() : '';
        let stockStatus: string | undefined;
        if (stockStatusRaw) {
            if (!isStockStatus(stockStatusRaw)) {
                errors.push({
                    row: rowNumber,
                    message: `Valor de existencias "${stockStatusRaw}" no reconocido para el SKU "${skuRaw}" (valores válidos: ${ALL_STOCK_STATUSES.join(', ')}).`,
                });
                return;
            }
            stockStatus = stockStatusRaw;
        }

        const priceRaw = mapping.price ? row[mapping.price] : undefined;
        const price = priceRaw ? parsePrice(priceRaw) : null;
        if (priceRaw && price === null) {
            errors.push({ row: rowNumber, message: `Precio inválido para el SKU "${skuRaw}".` });
            return;
        }

        validRows.push({
            row: rowNumber,
            sku: skuRaw,
            skuUpper,
            isUpdate,
            fields: {
                name,
                category: mapping.category ? row[mapping.category]?.trim() || undefined : undefined,
                activeComponents: mapping.activeComponents ? row[mapping.activeComponents]?.trim() || undefined : undefined,
                suggestedUse: mapping.suggestedUse ? row[mapping.suggestedUse]?.trim() || undefined : undefined,
                description: mapping.description ? row[mapping.description]?.trim() || undefined : undefined,
                contraindications: mapping.contraindications ? row[mapping.contraindications]?.trim() || undefined : undefined,
                presentation: mapping.presentation ? row[mapping.presentation]?.trim() || undefined : undefined,
                price: price ?? undefined,
                stockStatus,
                stockNote: mapping.stockNote ? row[mapping.stockNote]?.trim() || undefined : undefined,
                imageUrl: mapping.imageUrl ? row[mapping.imageUrl]?.trim() || undefined : undefined,
            },
        });
        if (isUpdate) toUpdate++;
        else toCreate++;
    });

    return {
        totalRows: rows.length,
        toCreate,
        toUpdate,
        errors,
        duplicateSkusInFile: Array.from(duplicateSkusInFile),
        validRows,
    };
}

/**
 * Aplica el plan contra la base real (FASE E). Modo `solo_precios`: SOLO
 * actualiza `product_variants.price` de variantes YA existentes — nunca crea
 * ni actualiza `products`, así que el trigger `mark_product_for_kb_sync()`
 * (migración 56 BLOQUE 8) nunca se dispara y ningún producto se marca para
 * resincronizar con la KB.
 *
 * Modo `completo`: el producto se resuelve por NOMBRE dentro del catálogo
 * (case-insensitive) — varias filas con el mismo nombre comparten el mismo
 * producto (varias presentaciones de un solo producto). La variante se
 * resuelve por SKU (case-insensitive), ya resuelta de antemano por
 * `buildImportPlan` vía `existingSkusUpper`.
 */
export async function applyImportPlan(
    fastify: FastifyInstance,
    catalogId: string,
    mode: CatalogImportMode,
    plan: ImportPlan,
    existingVariantsBySkuUpper: ReadonlyMap<string, { id: string; productId: string }>
): Promise<{ rowsCreated: number; rowsUpdated: number; rowsFailed: number; errors: ImportRowError[]; imageErrors: ImportRowError[] }> {
    const errors: ImportRowError[] = [...plan.errors];
    const imageErrors: ImportRowError[] = [];
    let rowsCreated = 0;
    let rowsUpdated = 0;

    if (mode === CATALOG_IMPORT_MODES.SOLO_PRECIOS) {
        // Modo solo_precios no toca la capa descriptiva (AGENTS.md/FASE E):
        // una columna imageUrl mapeada aquí se ignora, nunca se descarga.
        for (const row of plan.validRows) {
            const existing = existingVariantsBySkuUpper.get(row.skuUpper);
            if (!existing) {
                errors.push({ row: row.row, message: `SKU "${row.sku}" ya no existe en el catálogo (posible carrera con otra importación).` });
                continue;
            }
            const { error } = await fastify.supabaseAdmin.from('product_variants').update({ price: row.fields.price }).eq('id', existing.id);
            if (error) {
                errors.push({ row: row.row, message: `No se pudo actualizar el precio del SKU "${row.sku}": ${error.message}` });
                continue;
            }
            rowsUpdated++;
        }
        return { rowsCreated, rowsUpdated, rowsFailed: errors.length, errors, imageErrors };
    }

    // Modo completo: resolver/crear producto por nombre, cacheado dentro de
    // esta corrida para que filas con el mismo nombre no creen productos duplicados.
    const productIdByNameUpper = new Map<string, string>();
    const { data: existingProducts } = await fastify.supabaseAdmin.from('products').select('id, name').eq('catalog_id', catalogId);
    for (const p of existingProducts ?? []) {
        productIdByNameUpper.set((p.name as string).toUpperCase(), p.id as string);
    }

    for (const row of plan.validRows) {
        try {
            const nameUpper = row.fields.name!.toUpperCase();
            let productId = productIdByNameUpper.get(nameUpper);

            if (!productId) {
                const { data: created, error: createErr } = await fastify.supabaseAdmin
                    .from('products')
                    .insert({
                        catalog_id: catalogId,
                        name: row.fields.name,
                        category: row.fields.category ?? null,
                        active_components: row.fields.activeComponents ?? null,
                        suggested_use: row.fields.suggestedUse ?? null,
                        description: row.fields.description ?? null,
                        contraindications: row.fields.contraindications ?? null,
                    })
                    .select('id')
                    .single();
                if (createErr || !created) throw new Error(createErr?.message ?? 'No se pudo crear el producto');
                productId = created.id as string;
                productIdByNameUpper.set(nameUpper, productId);
            }

            const existingVariant = existingVariantsBySkuUpper.get(row.skuUpper);
            const variantPayload = {
                product_id: productId,
                catalog_id: catalogId,
                sku: row.sku,
                presentation: row.fields.presentation ?? null,
                price: row.fields.price ?? null,
                stock_status: row.fields.stockStatus ?? STOCK_STATUSES.SIN_DATO,
                stock_note: row.fields.stockNote ?? null,
            };

            if (existingVariant) {
                const { error: updateErr } = await fastify.supabaseAdmin
                    .from('product_variants')
                    .update(variantPayload)
                    .eq('id', existingVariant.id);
                if (updateErr) throw new Error(updateErr.message);
                rowsUpdated++;
            } else {
                const { error: insertErr } = await fastify.supabaseAdmin.from('product_variants').insert(variantPayload);
                if (insertErr) throw new Error(insertErr.message);
                rowsCreated++;
            }

            // Fallo de imagen: se reporta aparte y NUNCA invalida la fila —
            // el producto/variante ya quedó creado o actualizado arriba.
            if (row.fields.imageUrl) {
                try {
                    await downloadAndAttachProductImage(fastify, catalogId, productId, row.fields.imageUrl);
                } catch (imgErr) {
                    imageErrors.push({
                        row: row.row,
                        message: `No se pudo descargar la imagen del SKU "${row.sku}": ${imgErr instanceof Error ? imgErr.message : String(imgErr)}`,
                    });
                }
            }
        } catch (err) {
            errors.push({ row: row.row, message: err instanceof Error ? err.message : String(err) });
        }
    }

    return { rowsCreated, rowsUpdated, rowsFailed: errors.length, errors, imageErrors };
}

/** Conjunto de SKU (mayúsculas) y mapa sku->variante ya existentes en el catálogo. */
export async function loadExistingCatalogVariants(
    fastify: FastifyInstance,
    catalogId: string
): Promise<{ skusUpper: Set<string>; bySkuUpper: Map<string, { id: string; productId: string }> }> {
    const { data, error } = await fastify.supabaseAdmin.from('product_variants').select('id, sku, product_id').eq('catalog_id', catalogId);
    if (error) throw new Error(`No se pudieron leer las variantes existentes del catálogo: ${error.message}`);

    const skusUpper = new Set<string>();
    const bySkuUpper = new Map<string, { id: string; productId: string }>();
    for (const row of data ?? []) {
        const upper = (row.sku as string).toUpperCase();
        skusUpper.add(upper);
        bySkuUpper.set(upper, { id: row.id as string, productId: row.product_id as string });
    }
    return { skusUpper, bySkuUpper };
}
