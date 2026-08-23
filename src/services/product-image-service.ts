import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { validateImageMagicBytes, MAX_PRODUCT_IMAGE_SIZE_BYTES } from '../lib/magic-bytes.js';

export const PRODUCT_IMAGES_BUCKET = 'product-images';

export interface UploadProductImageParams {
    catalogId: string;
    productId: string;
    fileName: string;
    fileBuffer: Buffer;
}

export interface ProductImageInfo {
    imagePath: string;
    mimeType: string;
    sizeBytes: number;
    uploadedAt: string;
}

/**
 * Asegura la existencia del bucket privado de imágenes de producto en
 * Supabase Storage. Mismo patrón que `ensureAttachmentBucket`
 * (services/attachment-service.ts).
 *
 * Un bucket ya creado con un `fileSizeLimit` anterior (512 KB) no se
 * actualiza solo — Supabase Storage no reaplica las opciones de creación en
 * cada arranque. Si el bucket ya existe, se llama `updateBucket` para
 * sincronizar el tope vigente (`MAX_PRODUCT_IMAGE_SIZE_BYTES`).
 */
export async function ensureProductImageBucket(fastify: FastifyInstance): Promise<void> {
    try {
        const { data: buckets } = await fastify.supabaseAdmin.storage.listBuckets();
        const exists = buckets?.some((b) => b.name === PRODUCT_IMAGES_BUCKET);
        if (!exists) {
            await fastify.supabaseAdmin.storage.createBucket(PRODUCT_IMAGES_BUCKET, {
                public: false,
                fileSizeLimit: MAX_PRODUCT_IMAGE_SIZE_BYTES,
            });
        } else {
            await fastify.supabaseAdmin.storage.updateBucket(PRODUCT_IMAGES_BUCKET, {
                public: false,
                fileSizeLimit: MAX_PRODUCT_IMAGE_SIZE_BYTES,
            });
        }
    } catch (err) {
        fastify.log.warn({ err }, '[ProductImageService] Error al verificar/crear/actualizar bucket de imágenes de producto');
    }
}

/**
 * Sube (o reemplaza) la imagen de un producto tras validar sus magic bytes
 * y el tope de 512 KB. Un producto tiene como máximo UNA imagen — si ya
 * tenía una, el objeto anterior se elimina de Storage en cuanto el nuevo
 * queda guardado (best-effort: si la limpieza falla, no revierte la subida
 * nueva, solo deja un objeto huérfano que no rompe nada funcionalmente).
 */
export async function uploadProductImage(fastify: FastifyInstance, params: UploadProductImageParams): Promise<ProductImageInfo> {
    const { catalogId, productId, fileName, fileBuffer } = params;

    const validated = validateImageMagicBytes(fileBuffer);
    if (!validated) {
        throw new Error(`La imagen no es válida. Solo se admiten PNG, JPEG y WebP de hasta ${Math.round(MAX_PRODUCT_IMAGE_SIZE_BYTES / (1024 * 1024))} MB.`);
    }

    await ensureProductImageBucket(fastify);

    const { data: existingProduct } = await fastify.supabaseAdmin
        .from('products')
        .select('image_path')
        .eq('id', productId)
        .eq('catalog_id', catalogId)
        .maybeSingle();

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${catalogId}/${productId}/${randomUUID()}-${safeName}`;

    const { error: uploadError } = await fastify.supabaseAdmin.storage
        .from(PRODUCT_IMAGES_BUCKET)
        .upload(storagePath, fileBuffer, { contentType: validated.mimeType, upsert: true });

    if (uploadError) {
        fastify.log.error({ uploadError, productId }, '[ProductImageService] Falló la subida a Storage');
        throw new Error(`Error al almacenar la imagen en Supabase Storage: ${uploadError.message}`);
    }

    const uploadedAt = new Date().toISOString();
    const { error: dbError } = await fastify.supabaseAdmin
        .from('products')
        .update({
            image_path: storagePath,
            image_mime_type: validated.mimeType,
            image_size_bytes: fileBuffer.length,
            image_uploaded_at: uploadedAt,
        })
        .eq('id', productId)
        .eq('catalog_id', catalogId);

    if (dbError) {
        // La imagen ya se subió a Storage pero no se pudo enlazar — se
        // intenta limpiar el objeto huérfano en vez de dejarlo colgado sin
        // ninguna fila que lo referencie.
        await fastify.supabaseAdmin.storage.from(PRODUCT_IMAGES_BUCKET).remove([storagePath]).catch(() => undefined);
        fastify.log.error({ dbError, productId }, '[ProductImageService] Falló el UPDATE de products.image_path');
        throw new Error(`Error al registrar la imagen en base de datos: ${dbError.message}`);
    }

    if (existingProduct?.image_path && existingProduct.image_path !== storagePath) {
        const { error: removeError } = await fastify.supabaseAdmin.storage.from(PRODUCT_IMAGES_BUCKET).remove([existingProduct.image_path]);
        if (removeError) {
            fastify.log.warn({ removeError, productId, oldPath: existingProduct.image_path }, '[ProductImageService] No se pudo borrar la imagen anterior (no bloquea la subida nueva)');
        }
    }

    return { imagePath: storagePath, mimeType: validated.mimeType, sizeBytes: fileBuffer.length, uploadedAt };
}

/**
 * URL firmada temporal para mostrar la imagen — el bucket es privado, así
 * que nunca se expone `image_path` tal cual al frontend. Mismo patrón que
 * `generateAttachmentSignedUrl`.
 */
export async function getProductImageSignedUrl(fastify: FastifyInstance, imagePath: string, expiresInSeconds = 3600): Promise<string | null> {
    try {
        const { data, error } = await fastify.supabaseAdmin.storage.from(PRODUCT_IMAGES_BUCKET).createSignedUrl(imagePath, expiresInSeconds);
        if (error || !data?.signedUrl) {
            fastify.log.warn({ error, imagePath }, '[ProductImageService] Error generando signedUrl');
            return null;
        }
        return data.signedUrl;
    } catch (err) {
        fastify.log.error({ err, imagePath }, '[ProductImageService] Excepción al generar signedUrl');
        return null;
    }
}

export const MAX_BATCH_IMAGE_PRODUCT_IDS = 100;

export interface ProductImageBatchEntry {
    imageUrl: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    uploadedAt: string | null;
}

/**
 * Firma en un solo viaje las imágenes de varios productos de un mismo
 * catálogo (solo lectura — VIEW_CATALOG, no MANAGE_CATALOG). Pensado para una
 * lista/tabla que solo debe firmar lo visible en pantalla, nunca todo el
 * catálogo de una vez: el llamador debe acotar `productIds` a la página
 * actual (tope duro `MAX_BATCH_IMAGE_PRODUCT_IDS`).
 *
 * Un `productId` que no pertenezca a `catalogId`, o sin imagen, aparece en el
 * resultado con `imageUrl: null` — nunca se omite la clave ni se lanza error
 * por un id individual inválido.
 */
export async function getProductImagesBatch(
    fastify: FastifyInstance,
    catalogId: string,
    productIds: readonly string[]
): Promise<Record<string, ProductImageBatchEntry>> {
    const uniqueIds = Array.from(new Set(productIds)).slice(0, MAX_BATCH_IMAGE_PRODUCT_IDS);
    const images: Record<string, ProductImageBatchEntry> = {};
    for (const id of uniqueIds) {
        images[id] = { imageUrl: null, mimeType: null, sizeBytes: null, uploadedAt: null };
    }
    if (uniqueIds.length === 0) return images;

    const { data, error } = await fastify.supabaseAdmin
        .from('products')
        .select('id, image_path, image_mime_type, image_size_bytes, image_uploaded_at')
        .eq('catalog_id', catalogId)
        .in('id', uniqueIds);

    if (error) {
        fastify.log.error({ error, catalogId }, '[ProductImageService] Error leyendo imágenes en lote');
        return images;
    }

    await Promise.all(
        (data ?? []).map(async (row) => {
            if (!row.image_path) return;
            const imageUrl = await getProductImageSignedUrl(fastify, row.image_path as string);
            images[row.id as string] = {
                imageUrl,
                mimeType: row.image_mime_type as string | null,
                sizeBytes: row.image_size_bytes as number | null,
                uploadedAt: row.image_uploaded_at as string | null,
            };
        })
    );

    return images;
}

/**
 * Quita la imagen de un producto: borra el objeto en Storage y limpia las
 * columnas relacionadas. Devuelve `true` incluso si el producto no tenía
 * imagen (estado deseado ya cumplido) — solo `false` ante un error real.
 */
export async function deleteProductImage(fastify: FastifyInstance, catalogId: string, productId: string): Promise<boolean> {
    const { data: product, error: readError } = await fastify.supabaseAdmin
        .from('products')
        .select('image_path')
        .eq('id', productId)
        .eq('catalog_id', catalogId)
        .maybeSingle();

    if (readError) {
        fastify.log.error({ readError, productId }, '[ProductImageService] Error leyendo el producto antes de borrar su imagen');
        return false;
    }
    if (!product || !product.image_path) {
        return true;
    }

    const { error: removeError } = await fastify.supabaseAdmin.storage.from(PRODUCT_IMAGES_BUCKET).remove([product.image_path]);
    if (removeError) {
        fastify.log.error({ removeError, productId }, '[ProductImageService] Error borrando la imagen de Storage');
        return false;
    }

    const { error: updateError } = await fastify.supabaseAdmin
        .from('products')
        .update({ image_path: null, image_mime_type: null, image_size_bytes: null, image_uploaded_at: null })
        .eq('id', productId)
        .eq('catalog_id', catalogId);

    if (updateError) {
        fastify.log.error({ updateError, productId }, '[ProductImageService] Error limpiando image_path tras borrar de Storage');
        return false;
    }

    return true;
}
