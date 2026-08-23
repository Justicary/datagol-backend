import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { productsToolRoute } from '../src/routes/tools/products.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { setFeatureOverride, clearEntitlementsCache } from '../src/services/entitlements.js';
import { FEATURE_KEYS } from '../src/types/feature-taxonomy.js';
import * as productImageService from '../src/services/product-image-service.js';

const TEST_TOOL_SECRET = 'products-route-test-secret';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(productsToolRoute);
    await app.ready();
    return app;
}

describe('POST /tools/:webhookToken/products', () => {
    const TEST_WEBHOOK_TOKEN = `products-test-token-${Date.now()}`;
    let orgId: string;
    let groupId: string;
    let catalogId: string;
    let productId: string;
    let variantId: string;
    const SKU = `PROD-TOOL-${Date.now()}`;

    beforeAll(async () => {
        const { data: group } = await supabaseAdmin.from('credential_groups').insert({ name: 'Grupo (tools-products.test.ts)' }).select('id').single();
        groupId = group!.id;

        const { data: org, error: orgErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org (tools-products.test.ts)',
                email: `org-tools-products-test-${Date.now()}@example.invalid`,
                credential_group_id: groupId,
                webhook_token: TEST_WEBHOOK_TOKEN,
            })
            .select('id')
            .single();
        if (orgErr || !org) throw new Error(`No se pudo crear la organización: ${orgErr?.message}`);
        orgId = org.id;
        await supabaseAdmin.from('credential_groups').update({ owner_organization_id: orgId }).eq('id', groupId);

        const saved = await setSecret(orgId, SECRET_KEYS.TOOL_WEBHOOK_SECRET, TEST_TOOL_SECRET);
        if (!saved) throw new Error('No se pudo guardar tool_webhook_secret de prueba');

        const overrideResult = await setFeatureOverride(orgId, FEATURE_KEYS.PRODUCT_RAG, true, 'Prueba tools-products.test.ts');
        if (!overrideResult.success) throw new Error(`No se pudo habilitar product_rag: ${overrideResult.error}`);
        clearEntitlementsCache(orgId);

        const { data: catalog, error: catErr } = await supabaseAdmin
            .from('catalogs')
            .insert({ owner_organization_id: orgId, name: 'Catálogo (tools-products.test.ts)' })
            .select('id')
            .single();
        if (catErr || !catalog) throw new Error(`No se pudo crear el catálogo: ${catErr?.message}`);
        catalogId = catalog.id;

        const { data: product, error: prodErr } = await supabaseAdmin
            .from('products')
            .insert({ catalog_id: catalogId, name: 'Producto de prueba tool' })
            .select('id')
            .single();
        if (prodErr || !product) throw new Error(`No se pudo crear el producto: ${prodErr?.message}`);
        productId = product.id;

        const { data: variant, error: varErr } = await supabaseAdmin
            .from('product_variants')
            .insert({
                product_id: productId,
                catalog_id: catalogId,
                sku: SKU,
                presentation: '60 ml',
                price: 150,
                currency: 'MXN',
                price_includes_tax: true,
                stock_status: 'disponible',
            })
            .select('id')
            .single();
        if (varErr || !variant) throw new Error(`No se pudo crear la variante: ${varErr?.message}`);
        variantId = variant.id;
    });

    afterAll(async () => {
        await supabaseAdmin.from('organization_variant_overrides').delete().eq('variant_id', variantId);
        await supabaseAdmin.from('catalogs').delete().eq('id', catalogId);
        await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await supabaseAdmin.from('credential_groups').delete().eq('id', groupId);
    });

    it('rechaza con 401 cuando el webhookToken no resuelve a ninguna organización', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/tools/token-inexistente/products',
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { skus: [SKU] },
            });
            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: SKU existente devuelve precio del catálogo (sin override), IVA incluido y disponibilidad matizada', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/products`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { skus: [SKU] },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.results).toHaveLength(1);
            expect(body.results[0]).toMatchObject({
                sku: SKU,
                found: true,
                presentation: '60 ml',
                price: 150,
                currency: 'MXN',
                priceIncludesTax: true,
                availabilityText: 'Según mi información hay disponible, aunque conviene confirmarlo',
            });
            // Nunca campos internos.
            expect(body.results[0]).not.toHaveProperty('id');
            expect(body.results[0]).not.toHaveProperty('productId');
            expect(body.results[0]).not.toHaveProperty('variantId');
        } finally {
            await app.close();
        }
    });

    it('el tool resuelve el OVERRIDE de sucursal cuando existe, en vez del precio de catálogo', async () => {
        await supabaseAdmin.from('organization_variant_overrides').insert({
            organization_id: orgId,
            variant_id: variantId,
            price: 199,
            stock_status: 'bajo',
        });

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/products`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { skus: [SKU] },
            });
            const body = response.json();
            expect(body.results[0].price).toBe(199);
            expect(body.results[0].availabilityText).toBe('Me aparece con poca existencia');
        } finally {
            await supabaseAdmin.from('organization_variant_overrides').delete().eq('variant_id', variantId).eq('organization_id', orgId);
            await app.close();
        }
    });

    it('contraparte de éxito: producto con imagen incluye imageUrl firmada (requiere db/migrations/62_resolve_variant_image.sql aplicada)', async () => {
        await supabaseAdmin.from('products').update({ image_path: `${catalogId}/${productId}/foto.png` }).eq('id', productId);
        vi.spyOn(productImageService, 'getProductImageSignedUrl').mockResolvedValue('https://storage.supabase.co/signed/foto.png');

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/products`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { skus: [SKU] },
            });
            expect(response.json().results[0].imageUrl).toBe('https://storage.supabase.co/signed/foto.png');
        } finally {
            vi.restoreAllMocks();
            await supabaseAdmin.from('products').update({ image_path: null }).eq('id', productId);
            await app.close();
        }
    });

    it('contraparte: producto sin imagen devuelve imageUrl null sin llamar a Storage', async () => {
        const spy = vi.spyOn(productImageService, 'getProductImageSignedUrl');
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/products`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { skus: [SKU] },
            });
            expect(response.json().results[0].imageUrl).toBeNull();
            expect(spy).not.toHaveBeenCalled();
        } finally {
            vi.restoreAllMocks();
            await app.close();
        }
    });

    it('SKU que no existe se reporta found=false, sin campos de precio', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/products`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { skus: ['SKU-QUE-NO-EXISTE-XYZ'] },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.results[0]).toMatchObject({ sku: 'SKU-QUE-NO-EXISTE-XYZ', found: false });
            expect(body.results[0].price).toBeUndefined();
        } finally {
            await app.close();
        }
    });

    it('más de 3 SKU se trunca a los primeros 3, sin rechazar la petición', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/products`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { skus: ['A', 'B', 'C', 'D', 'E'] },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().results).toHaveLength(3);
        } finally {
            await app.close();
        }
    });

    it.each(['disponible', 'bajo', 'agotado', 'bajo_pedido', 'sin_dato'] as const)(
        'mapea stock_status "%s" al texto hablado correcto (FASE D)',
        async (stockStatus) => {
            await supabaseAdmin.from('product_variants').update({ stock_status: stockStatus }).eq('id', variantId);

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/tools/${TEST_WEBHOOK_TOKEN}/products`,
                    headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                    payload: { skus: [SKU] },
                });
                const body = response.json();
                const expected: Record<string, string> = {
                    disponible: 'Según mi información hay disponible, aunque conviene confirmarlo',
                    bajo: 'Me aparece con poca existencia',
                    agotado: 'Me aparece agotado',
                    bajo_pedido: 'Es sobre pedido',
                    sin_dato: 'No tengo la disponibilidad a la mano',
                };
                expect(body.results[0].availabilityText).toBe(expected[stockStatus]);
            } finally {
                await app.close();
            }
        }
    );

    it('feature product_rag deshabilitada: responde degradado con results vacío, nunca expone el catálogo', async () => {
        await setFeatureOverride(orgId, FEATURE_KEYS.PRODUCT_RAG, false, 'Prueba de degradación');
        clearEntitlementsCache(orgId);

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/products`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { skus: [SKU] },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.results).toEqual([]);
            expect(body.message).toBeTruthy();
        } finally {
            await setFeatureOverride(orgId, FEATURE_KEYS.PRODUCT_RAG, true, 'Restaurar tras prueba de degradación');
            clearEntitlementsCache(orgId);
            await app.close();
        }
    });
});
