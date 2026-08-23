import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ALL_STOCK_STATUSES, isStockStatus, stockStatusToSpeech, STOCK_STATUS_SPEECH } from '../src/types/stock-status.js';
import { ALL_KB_SYNC_STATUSES, isKbSyncStatus } from '../src/types/product-kb-sync-status.js';
import {
    ALL_CATALOG_IMPORT_MODES,
    isCatalogImportMode,
    ALL_CATALOG_IMPORT_STATUSES,
    isCatalogImportStatus,
} from '../src/types/catalog-import.js';
import { ALL_ELEVENLABS_PLAN_KEYS, isElevenLabsPlanKey } from '../src/types/elevenlabs-plan-key.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * Módulos de constraint de la Fase A (docs/tasks/catalogo-productos-grupos-cred.md).
 * Mismo patrón de verificación que __tests__/secret-keys.test.ts: insertar
 * cada valor contra la base real y fallar si el CHECK constraint lo rechaza,
 * en vez de confiar en la lista del módulo por sí sola.
 *
 * `organizations.credential_group_id` es NOT NULL desde
 * db/migrations/56_catalogo_productos.sql BLOQUE 2, y todavía no existe (a la
 * fecha de este archivo) un trigger que aprovisione el grupo de uno
 * automáticamente al insertar — eso es trabajo de la Fase B de esta misma
 * tarea. Hasta entonces, cualquier prueba que inserte una organización debe
 * crear su credential_groups explícitamente primero.
 */
async function createTestOrgWithGroup(name: string, email: string): Promise<{ orgId: string; groupId: string }> {
    const { data: group, error: groupErr } = await supabaseAdmin
        .from('credential_groups')
        .insert({ name: `Grupo (${name})` })
        .select('id')
        .single();
    if (groupErr || !group) throw new Error(`No se pudo crear credential_groups de prueba: ${groupErr?.message}`);

    const { data: org, error: orgErr } = await supabaseAdmin
        .from('organizations')
        .insert({ name, email, credential_group_id: group.id })
        .select('id')
        .single();
    if (orgErr || !org) throw new Error(`No se pudo crear la organización de prueba: ${orgErr?.message}`);

    return { orgId: org.id, groupId: group.id };
}

async function deleteTestOrgWithGroup(orgId: string, groupId: string): Promise<void> {
    await supabaseAdmin.from('organizations').delete().eq('id', orgId);
    await supabaseAdmin.from('credential_groups').delete().eq('id', groupId);
}
describe('src/types/stock-status.ts — sincronizado con product_variants_stock_status_check', () => {
    let orgId: string;
    let groupId: string;
    let catalogId: string;
    let productId: string;

    beforeAll(async () => {
        const org = await createTestOrgWithGroup('Test Org (catalog-enums.test.ts)', `test-catalog-enums-${Date.now()}@example.invalid`);
        orgId = org.orgId;
        groupId = org.groupId;

        const { data: catalog, error: catErr } = await supabaseAdmin
            .from('catalogs')
            .insert({ owner_organization_id: orgId, name: 'Catálogo diagnóstico' })
            .select('id')
            .single();
        if (catErr || !catalog) throw new Error(`No se pudo crear el catálogo de prueba: ${catErr?.message}`);
        catalogId = catalog.id;

        const { data: product, error: prodErr } = await supabaseAdmin
            .from('products')
            .insert({ catalog_id: catalogId, name: 'Producto diagnóstico' })
            .select('id')
            .single();
        if (prodErr || !product) throw new Error(`No se pudo crear el producto de prueba: ${prodErr?.message}`);
        productId = product.id;
    });

    afterAll(async () => {
        if (catalogId) {
            await supabaseAdmin.from('catalogs').delete().eq('id', catalogId);
        }
        if (orgId && groupId) {
            await deleteTestOrgWithGroup(orgId, groupId);
        }
    });

    it.each(ALL_STOCK_STATUSES)('el stock_status "%s" es aceptado por product_variants_stock_status_check', async (stockStatus) => {
        const sku = `DIAG-${stockStatus}-${Math.random().toString(36).slice(2)}`;
        const { error } = await supabaseAdmin
            .from('product_variants')
            .insert({ product_id: productId, catalog_id: catalogId, sku, stock_status: stockStatus });

        expect(error?.code).not.toBe('23514');

        await supabaseAdmin.from('product_variants').delete().eq('catalog_id', catalogId).eq('sku', sku);
    });

    it.each(ALL_STOCK_STATUSES)('isStockStatus("%s") es true', (stockStatus) => {
        expect(isStockStatus(stockStatus)).toBe(true);
    });

    it('isStockStatus rechaza un valor fuera del dominio', () => {
        expect(isStockStatus('en_camion')).toBe(false);
    });

    it.each(ALL_STOCK_STATUSES)('STOCK_STATUS_SPEECH["%s"] nunca afirma la existencia como un hecho categórico', (stockStatus) => {
        const speech = STOCK_STATUS_SPEECH[stockStatus];
        expect(speech.toLowerCase()).not.toContain('sí tenemos');
        expect(speech.length).toBeGreaterThan(0);
    });

    it('stockStatusToSpeech degrada a sin_dato para un valor desconocido', () => {
        expect(stockStatusToSpeech('valor_invalido')).toBe(STOCK_STATUS_SPEECH.sin_dato);
    });
});

describe('src/types/product-kb-sync-status.ts — sincronizado con product_kb_sync_status_check', () => {
    let orgId: string;
    let catalogId: string;
    let productId: string;
    let groupId: string;

    beforeAll(async () => {
        const org = await createTestOrgWithGroup('Test Org (kb-sync-status)', `test-kb-sync-status-${Date.now()}@example.invalid`);
        orgId = org.orgId;
        groupId = org.groupId;

        const { data: catalog, error: catErr } = await supabaseAdmin
            .from('catalogs')
            .insert({ owner_organization_id: orgId, name: 'Catálogo diagnóstico (kb-sync)' })
            .select('id')
            .single();
        if (catErr || !catalog) throw new Error(`No se pudo crear el catálogo de prueba: ${catErr?.message}`);
        catalogId = catalog.id;

        const { data: product, error: prodErr } = await supabaseAdmin
            .from('products')
            .insert({ catalog_id: catalogId, name: 'Producto diagnóstico (kb-sync)' })
            .select('id')
            .single();
        if (prodErr || !product) throw new Error(`No se pudo crear el producto de prueba: ${prodErr?.message}`);
        productId = product.id;
    });

    afterAll(async () => {
        if (catalogId) {
            await supabaseAdmin.from('catalogs').delete().eq('id', catalogId);
        }
        if (orgId && groupId) {
            await deleteTestOrgWithGroup(orgId, groupId);
        }
    });

    it.each(ALL_KB_SYNC_STATUSES)('el status "%s" es aceptado por product_kb_sync_status_check', async (status) => {
        const { error } = await supabaseAdmin
            .from('product_kb_sync')
            .upsert(
                { product_id: productId, credential_group_id: groupId, status },
                { onConflict: 'product_id,credential_group_id' }
            );

        expect(error?.code).not.toBe('23514');
    });

    it.each(ALL_KB_SYNC_STATUSES)('isKbSyncStatus("%s") es true', (status) => {
        expect(isKbSyncStatus(status)).toBe(true);
    });
});

describe('src/types/catalog-import.ts — sincronizado con catalog_imports_mode_check / catalog_imports_status_check', () => {
    let orgId: string;
    let groupId: string;
    let catalogId: string;

    beforeAll(async () => {
        const org = await createTestOrgWithGroup('Test Org (catalog-imports)', `test-catalog-imports-${Date.now()}@example.invalid`);
        orgId = org.orgId;
        groupId = org.groupId;

        const { data: catalog, error: catErr } = await supabaseAdmin
            .from('catalogs')
            .insert({ owner_organization_id: orgId, name: 'Catálogo diagnóstico (imports)' })
            .select('id')
            .single();
        if (catErr || !catalog) throw new Error(`No se pudo crear el catálogo de prueba: ${catErr?.message}`);
        catalogId = catalog.id;
    });

    afterAll(async () => {
        if (catalogId) {
            await supabaseAdmin.from('catalogs').delete().eq('id', catalogId);
        }
        if (orgId && groupId) {
            await deleteTestOrgWithGroup(orgId, groupId);
        }
    });

    it.each(ALL_CATALOG_IMPORT_MODES)('el mode "%s" es aceptado por catalog_imports_mode_check', async (mode) => {
        const { data, error } = await supabaseAdmin
            .from('catalog_imports')
            .insert({ catalog_id: catalogId, mode })
            .select('id')
            .single();

        expect(error?.code).not.toBe('23514');
        if (data) await supabaseAdmin.from('catalog_imports').delete().eq('id', data.id);
    });

    it.each(ALL_CATALOG_IMPORT_STATUSES)('el status "%s" es aceptado por catalog_imports_status_check', async (status) => {
        const { data, error } = await supabaseAdmin
            .from('catalog_imports')
            .insert({ catalog_id: catalogId, status })
            .select('id')
            .single();

        expect(error?.code).not.toBe('23514');
        if (data) await supabaseAdmin.from('catalog_imports').delete().eq('id', data.id);
    });

    it.each(ALL_CATALOG_IMPORT_MODES)('isCatalogImportMode("%s") es true', (mode) => {
        expect(isCatalogImportMode(mode)).toBe(true);
    });

    it.each(ALL_CATALOG_IMPORT_STATUSES)('isCatalogImportStatus("%s") es true', (status) => {
        expect(isCatalogImportStatus(status)).toBe(true);
    });
});

describe('src/types/elevenlabs-plan-key.ts — sincronizado con las filas reales de elevenlabs_plans', () => {
    it.each(ALL_ELEVENLABS_PLAN_KEYS)('el plan "%s" existe como fila real en elevenlabs_plans', async (planKey) => {
        const { data, error } = await supabaseAdmin.from('elevenlabs_plans').select('key').eq('key', planKey).maybeSingle();
        expect(error).toBeNull();
        expect(data).not.toBeNull();
    });

    it.each(ALL_ELEVENLABS_PLAN_KEYS)('isElevenLabsPlanKey("%s") es true', (planKey) => {
        expect(isElevenLabsPlanKey(planKey)).toBe(true);
    });

    it('isElevenLabsPlanKey rechaza un valor fuera del catálogo', () => {
        expect(isElevenLabsPlanKey('ultra')).toBe(false);
    });
});
