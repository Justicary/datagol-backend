import crypto from 'crypto';

/**
 * Datos de un producto necesarios para generar su documento de knowledge
 * base (docs/tasks/catalogo-productos-grupos-cred.md, FASE C.1). Deliberadamente
 * NO incluye `price`, `stock_status` ni ningún campo transaccional — la
 * regla número uno del módulo es que el precio nunca va a la KB, así que ese
 * dato ni siquiera se le pasa a esta función.
 */
export interface CatalogProductForKb {
    name: string;
    category: string | null;
    activeComponents: string | null;
    suggestedUse: string | null;
    description: string | null;
    contraindications: string | null;
    customFields?: Array<{ name: string; value: unknown }> | null;
}

export interface CatalogVariantForKb {
    sku: string;
    presentation: string | null;
    isActive: boolean;
}

export class NoActiveVariantsError extends Error {
    constructor(productName: string) {
        super(`El producto "${productName}" no tiene variantes activas — no se puede generar su documento de KB (no hay SKU que referenciar).`);
        this.name = 'NoActiveVariantsError';
    }
}

/**
 * Genera el documento de texto plano en español para la knowledge base de
 * ElevenLabs (FASE C.1). El SKU va al inicio y al final a propósito: la
 * última línea instruye al agente a usar el tool en vez de inventar un
 * precio o una existencia.
 *
 * Un producto puede tener varias variantes (presentaciones) con SKU propio
 * cada una — el documento es UNO por producto (product_kb_sync está
 * indexado por product_id, no por variante), así que se referencia un SKU
 * canónico: el de la variante activa con el `sku` alfabéticamente menor.
 * Las demás presentaciones se listan como texto descriptivo, no como
 * identificadores accionables — el agente pide el SKU al tool
 * (routes/tools/products.ts) para cualquiera de ellas.
 *
 * VERIFICACIÓN OBLIGATORIA (ver __tests__/catalog-kb-document.test.ts): el
 * documento generado NUNCA contiene precio ni cantidad de existencias. Es la
 * regla número uno del módulo — por eso esta función ni siquiera recibe esos
 * campos como parámetro, para que sea estructuralmente imposible filtrarlos.
 */
export function generateProductKbDocument(product: CatalogProductForKb, variants: readonly CatalogVariantForKb[]): string {
    const activeVariants = variants.filter((v) => v.isActive).slice().sort((a, b) => a.sku.localeCompare(b.sku));
    if (activeVariants.length === 0) {
        throw new NoActiveVariantsError(product.name);
    }

    const canonicalSku = activeVariants[0].sku;

    const presentations = Array.from(
        new Set(activeVariants.map((v) => v.presentation?.trim()).filter((p): p is string => Boolean(p)))
    );

    const bodyLines: string[] = [product.name];
    if (product.category) bodyLines.push(`Categoría: ${product.category}`);
    if (product.activeComponents) bodyLines.push(`Componentes activos: ${product.activeComponents}`);
    if (product.suggestedUse) bodyLines.push(`Uso sugerido: ${product.suggestedUse}`);
    if (product.description) bodyLines.push(product.description);
    if (product.contraindications) bodyLines.push(`Contraindicaciones: ${product.contraindications}`);
    if (product.customFields && product.customFields.length > 0) {
        for (const cf of product.customFields) {
            if (cf.value !== null && cf.value !== undefined && cf.value !== '') {
                bodyLines.push(`${cf.name}: ${cf.value}`);
            }
        }
    }
    if (presentations.length > 0) bodyLines.push(`Presentaciones: ${presentations.join(', ')}.`);

    return [
        `SKU: ${canonicalSku}`,
        '',
        ...bodyLines,
        '',
        `Para precio y disponibilidad, consultar SKU ${canonicalSku}.`,
    ].join('\n');
}

/**
 * Hash del contenido para `product_kb_sync.synced_content_hash` (FASE C.2):
 * permite al job de sincronización saltar la llamada a la API de ElevenLabs
 * cuando el documento no cambió desde la última sincronización.
 */
export function computeKbDocumentHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}
