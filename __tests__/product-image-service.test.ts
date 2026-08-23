import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../src/lib/supabase.js';
import {
    uploadProductImage,
    getProductImageSignedUrl,
    deleteProductImage,
    getProductImagesBatch,
    PRODUCT_IMAGES_BUCKET,
} from '../src/services/product-image-service.js';
import { MAX_PRODUCT_IMAGE_SIZE_BYTES } from '../src/lib/magic-bytes.js';

// PNG mínimo válido (firma de 8 bytes + relleno) — suficiente para pasar
// validateImageMagicBytes, que solo inspecciona los primeros 8 bytes.
function pngBuffer(sizeBytes = 100): Buffer {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([signature, Buffer.alloc(Math.max(0, sizeBytes - signature.length))]);
}

function jpegBuffer(): Buffer {
    return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}

/**
 * Igual que __tests__/thank-you-attachments.test.ts (AttachmentService): la
 * base de datos es real (catálogo/producto reales), pero Supabase Storage se
 * mockea — es un servicio externo de almacenamiento, no vale la pena tocarlo
 * de verdad en cada corrida de la suite.
 */
function buildFakeFastify(overrides: { storageOverrides?: Record<string, unknown> } = {}): { fastify: FastifyInstance; mocks: any } {
    const mockUpload = vi.fn().mockResolvedValue({ error: null });
    const mockCreateSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://storage.supabase.co/signed/producto.png' }, error: null });
    const mockRemove = vi.fn().mockResolvedValue({ error: null });
    const mockFrom = vi.fn().mockReturnValue({ upload: mockUpload, createSignedUrl: mockCreateSignedUrl, remove: mockRemove });

    // No se hace `{ ...supabaseAdmin }`: es una instancia de clase real, y un
    // spread solo copia propiedades PROPIAS enumerables — perdería los
    // métodos definidos en el prototipo (`.from()` dejaría de funcionar). Se
    // delega explícitamente en vez de clonar.
    const fastify = {
        supabaseAdmin: {
            from: (table: string) => supabaseAdmin.from(table),
            rpc: (fn: string, args?: Record<string, unknown>) => supabaseAdmin.rpc(fn, args),
            storage: {
                listBuckets: vi.fn().mockResolvedValue({ data: [{ name: PRODUCT_IMAGES_BUCKET }] }),
                createBucket: vi.fn().mockResolvedValue({ error: null }),
                from: mockFrom,
                ...overrides.storageOverrides,
            },
        },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as FastifyInstance;

    return { fastify, mocks: { mockUpload, mockCreateSignedUrl, mockRemove, mockFrom } };
}

describe('src/services/product-image-service.ts', () => {
    let orgId: string;
    let groupId: string;
    let catalogId: string;
    let productId: string;

    beforeAll(async () => {
        const { data: group } = await supabaseAdmin.from('credential_groups').insert({ name: 'Grupo (product-image-service.test.ts)' }).select('id').single();
        groupId = group!.id;
        const { data: org } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org (product-image-service.test.ts)', email: `org-product-image-test-${Date.now()}@example.invalid`, credential_group_id: groupId })
            .select('id')
            .single();
        orgId = org!.id;
        await supabaseAdmin.from('credential_groups').update({ owner_organization_id: orgId }).eq('id', groupId);

        const { data: catalog } = await supabaseAdmin.from('catalogs').insert({ owner_organization_id: orgId, name: 'Catálogo (product-image-service.test.ts)' }).select('id').single();
        catalogId = catalog!.id;

        const { data: product } = await supabaseAdmin.from('products').insert({ catalog_id: catalogId, name: 'Producto con imagen' }).select('id').single();
        productId = product!.id;
    });

    afterAll(async () => {
        await supabaseAdmin.from('catalogs').delete().eq('id', catalogId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await supabaseAdmin.from('credential_groups').delete().eq('id', groupId);
    });

    beforeEach(async () => {
        await supabaseAdmin.from('products').update({ image_path: null, image_mime_type: null, image_size_bytes: null, image_uploaded_at: null }).eq('id', productId);
    });

    describe('uploadProductImage', () => {
        it('sube un PNG válido, lo enlaza en products y devuelve la info de la imagen', async () => {
            const { fastify, mocks } = buildFakeFastify();
            const result = await uploadProductImage(fastify, { catalogId, productId, fileName: 'foto.png', fileBuffer: pngBuffer() });

            expect(result.mimeType).toBe('image/png');
            expect(mocks.mockUpload).toHaveBeenCalledTimes(1);

            const { data: row } = await supabaseAdmin.from('products').select('image_path, image_mime_type').eq('id', productId).single();
            expect(row?.image_path).toBe(result.imagePath);
            expect(row?.image_mime_type).toBe('image/png');
        });

        it('contraparte de éxito: también acepta JPEG', async () => {
            const { fastify } = buildFakeFastify();
            const result = await uploadProductImage(fastify, { catalogId, productId, fileName: 'foto.jpg', fileBuffer: jpegBuffer() });
            expect(result.mimeType).toBe('image/jpeg');
        });

        it('contraparte de rechazo: un archivo que no es imagen (PDF) se rechaza, nunca se sube a Storage', async () => {
            const { fastify, mocks } = buildFakeFastify();
            const pdfBuffer = Buffer.from('%PDF-1.7\ncontenido');

            await expect(uploadProductImage(fastify, { catalogId, productId, fileName: 'doc.pdf', fileBuffer: pdfBuffer })).rejects.toThrow(/no es válida/);
            expect(mocks.mockUpload).not.toHaveBeenCalled();
        });

        it('un PNG que excede el tope (5 MB) se rechaza, nunca se sube a Storage', async () => {
            const { fastify, mocks } = buildFakeFastify();
            const oversized = pngBuffer(MAX_PRODUCT_IMAGE_SIZE_BYTES + 1);

            await expect(uploadProductImage(fastify, { catalogId, productId, fileName: 'grande.png', fileBuffer: oversized })).rejects.toThrow(/MB/);
            expect(mocks.mockUpload).not.toHaveBeenCalled();
        });

        it('contraparte de éxito: un WebP válido también se acepta', async () => {
            const { fastify } = buildFakeFastify();
            const webp = Buffer.concat([Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), Buffer.alloc(20)]);
            const result = await uploadProductImage(fastify, { catalogId, productId, fileName: 'foto.webp', fileBuffer: webp });
            expect(result.mimeType).toBe('image/webp');
        });

        it('contraparte de éxito: un PNG justo en el límite (5 MB) se acepta', async () => {
            const { fastify, mocks } = buildFakeFastify();
            const atLimit = pngBuffer(MAX_PRODUCT_IMAGE_SIZE_BYTES);
            await expect(uploadProductImage(fastify, { catalogId, productId, fileName: 'limite.png', fileBuffer: atLimit })).resolves.toBeDefined();
            expect(mocks.mockUpload).toHaveBeenCalledTimes(1);
        });

        it('subir una segunda imagen reemplaza la anterior: borra el objeto viejo de Storage', async () => {
            const { fastify: fastify1 } = buildFakeFastify();
            const first = await uploadProductImage(fastify1, { catalogId, productId, fileName: 'primera.png', fileBuffer: pngBuffer() });

            const { fastify: fastify2, mocks: mocks2 } = buildFakeFastify();
            await uploadProductImage(fastify2, { catalogId, productId, fileName: 'segunda.png', fileBuffer: pngBuffer() });

            expect(mocks2.mockRemove).toHaveBeenCalledWith([first.imagePath]);
        });
    });

    describe('getProductImageSignedUrl', () => {
        it('devuelve la URL firmada de Storage', async () => {
            const { fastify } = buildFakeFastify();
            const url = await getProductImageSignedUrl(fastify, 'algun/path.png');
            expect(url).toBe('https://storage.supabase.co/signed/producto.png');
        });

        it('contraparte de rechazo: si Storage devuelve error, se devuelve null en vez de lanzar', async () => {
            const { fastify } = buildFakeFastify({
                storageOverrides: {
                    from: vi.fn().mockReturnValue({ createSignedUrl: vi.fn().mockResolvedValue({ data: null, error: { message: 'no encontrado' } }) }),
                },
            });
            expect(await getProductImageSignedUrl(fastify, 'algun/path.png')).toBeNull();
        });
    });

    describe('getProductImagesBatch', () => {
        it('devuelve la URL firmada solo para el producto con imagen, y null para el resto', async () => {
            const { fastify: uploadFastify } = buildFakeFastify();
            const uploaded = await uploadProductImage(uploadFastify, { catalogId, productId, fileName: 'lote.png', fileBuffer: pngBuffer() });

            const { data: otherProduct } = await supabaseAdmin.from('products').insert({ catalog_id: catalogId, name: 'Producto sin imagen (batch)' }).select('id').single();

            const { fastify } = buildFakeFastify();
            const result = await getProductImagesBatch(fastify, catalogId, [productId, otherProduct!.id]);

            expect(result[productId].imageUrl).toBe('https://storage.supabase.co/signed/producto.png');
            expect(result[productId].mimeType).toBe(uploaded.mimeType);
            expect(result[otherProduct!.id].imageUrl).toBeNull();

            await supabaseAdmin.from('products').delete().eq('id', otherProduct!.id);
        });

        it('contraparte: un productId ajeno al catálogo se ignora (no filtra imágenes de otro catálogo)', async () => {
            const { data: otherCatalog } = await supabaseAdmin.from('catalogs').insert({ owner_organization_id: orgId, name: 'Otro catálogo (batch)' }).select('id').single();
            const { data: foreignProduct } = await supabaseAdmin.from('products').insert({ catalog_id: otherCatalog!.id, name: 'Producto de otro catálogo' }).select('id').single();

            const { fastify } = buildFakeFastify();
            const result = await getProductImagesBatch(fastify, catalogId, [foreignProduct!.id]);

            expect(result[foreignProduct!.id]).toEqual({ imageUrl: null, mimeType: null, sizeBytes: null, uploadedAt: null });

            await supabaseAdmin.from('catalogs').delete().eq('id', otherCatalog!.id);
        });

        it('lista vacía devuelve objeto vacío sin llamar a Storage', async () => {
            const { fastify, mocks } = buildFakeFastify();
            const result = await getProductImagesBatch(fastify, catalogId, []);
            expect(result).toEqual({});
            expect(mocks.mockFrom).not.toHaveBeenCalled();
        });
    });

    describe('deleteProductImage', () => {
        it('borra la imagen de Storage y limpia las columnas en products', async () => {
            const { fastify: uploadFastify } = buildFakeFastify();
            const uploaded = await uploadProductImage(uploadFastify, { catalogId, productId, fileName: 'a-borrar.png', fileBuffer: pngBuffer() });

            const { fastify, mocks } = buildFakeFastify();
            const result = await deleteProductImage(fastify, catalogId, productId);

            expect(result).toBe(true);
            expect(mocks.mockRemove).toHaveBeenCalledWith([uploaded.imagePath]);

            const { data: row } = await supabaseAdmin.from('products').select('image_path').eq('id', productId).single();
            expect(row?.image_path).toBeNull();
        });

        it('contraparte: un producto sin imagen devuelve true sin llamar a Storage (estado deseado ya cumplido)', async () => {
            const { fastify, mocks } = buildFakeFastify();
            const result = await deleteProductImage(fastify, catalogId, productId);
            expect(result).toBe(true);
            expect(mocks.mockRemove).not.toHaveBeenCalled();
        });
    });
});
