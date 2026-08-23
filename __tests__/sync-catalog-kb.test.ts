import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { generateProductKbDocument, computeKbDocumentHash } from '../src/services/catalog-kb-document.js';

vi.mock('../src/services/elevenlabs-kb-client.js', async () => {
    const actual = await vi.importActual<typeof import('../src/services/elevenlabs-kb-client.js')>(
        '../src/services/elevenlabs-kb-client.js'
    );
    return {
        ...actual,
        createOrUpdateKbTextDocument: vi.fn(),
        deleteKbDocument: vi.fn(),
        triggerRagIndex: vi.fn(),
        createKbFolder: vi.fn(),
        getKbUsage: vi.fn(),
    };
});

import {
    createOrUpdateKbTextDocument,
    deleteKbDocument,
    triggerRagIndex,
    createKbFolder,
    getKbUsage,
} from '../src/services/elevenlabs-kb-client.js';
import {
    syncCatalogKbHandler,
    syncCatalogKbSweepHandler,
    isDueForRetry,
    type SyncCatalogKbJobData,
    type PendingSyncRow,
} from '../src/jobs/sync-catalog-kb.js';

/**
 * `isDueForRetry` en aislamiento (sin DB): `product_kb_sync` tiene su propio
 * trigger `set_updated_at()` (migración 56 BLOQUE 8) que fuerza
 * `updated_at` a `now()` en CUALQUIER UPDATE — es estructuralmente
 * imposible "atrasar" esa columna escribiéndola directamente en una prueba
 * de integración. El caso "el backoff ya venció" se prueba aquí, puro; la
 * integración contra la base solo cubre "recién falló, no se reprocesa
 * todavía" (donde updated_at=now() es exactamente lo que se necesita).
 */
describe('src/jobs/sync-catalog-kb.ts — isDueForRetry', () => {
    function buildRow(overrides: Partial<PendingSyncRow>): PendingSyncRow {
        return { product_id: 'p1', kb_document_id: null, synced_content_hash: null, status: 'pendiente', attempts: 0, updated_at: new Date().toISOString(), ...overrides };
    }

    it('un producto "pendiente" siempre está listo, sin importar updated_at', () => {
        expect(isDueForRetry(buildRow({ status: 'pendiente', updated_at: new Date().toISOString() }))).toBe(true);
    });

    it('un producto "error" recién fallado (updated_at=ahora) NO está listo', () => {
        expect(isDueForRetry(buildRow({ status: 'error', attempts: 1, updated_at: new Date().toISOString() }))).toBe(false);
    });

    it('contraparte: un producto "error" cuyo backoff ya venció (2^attempts minutos atrás) SÍ está listo', () => {
        const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
        // attempts=1 → backoff de 2^1=2 minutos; hace 3 minutos ya venció.
        expect(isDueForRetry(buildRow({ status: 'error', attempts: 1, updated_at: threeMinutesAgo }))).toBe(true);
    });

    it('más intentos exige más tiempo de espera (backoff exponencial real)', () => {
        const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
        // attempts=2 → backoff de 2^2=4 minutos; 3 minutos todavía no alcanza.
        expect(isDueForRetry(buildRow({ status: 'error', attempts: 2, updated_at: threeMinutesAgo }))).toBe(false);
    });

    it('el backoff tiene un tope (MAX_BACKOFF_ATTEMPTS): attempts muy altos no esperan para siempre', () => {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        // 2^6=64 min de tope — 1 hora (60 min) todavía no alcanza el tope de 64.
        expect(isDueForRetry(buildRow({ status: 'error', attempts: 100, updated_at: oneHourAgo }))).toBe(false);
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        expect(isDueForRetry(buildRow({ status: 'error', attempts: 100, updated_at: twoHoursAgo }))).toBe(true);
    });
});

function buildFakeFastify(): FastifyInstance {
    return {
        supabaseAdmin,
        log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    } as unknown as FastifyInstance;
}

function buildJob(data: SyncCatalogKbJobData): Job<SyncCatalogKbJobData> {
    return { id: 'fake-job-id', data } as unknown as Job<SyncCatalogKbJobData>;
}

async function getSyncRow(productId: string, credentialGroupId: string) {
    const { data } = await supabaseAdmin
        .from('product_kb_sync')
        .select('status, kb_document_id, synced_content_hash, attempts, updated_at, synced_at, rag_indexed_at')
        .eq('product_id', productId)
        .eq('credential_group_id', credentialGroupId)
        .maybeSingle();
    return data;
}

describe('src/jobs/sync-catalog-kb.ts', () => {
    let groupId: string;
    let ownerOrgId: string;
    let catalogId: string;
    const API_KEY_VALUE = 'sk_test_fake_elevenlabs_key_sync';

    beforeAll(async () => {
        const { data: group, error: groupErr } = await supabaseAdmin
            .from('credential_groups')
            .insert({ name: 'Grupo (sync-catalog-kb.test.ts)' })
            .select('id')
            .single();
        if (groupErr || !group) throw new Error(`No se pudo crear el grupo: ${groupErr?.message}`);
        groupId = group.id;

        const { data: owner, error: ownerErr } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Owner (sync-catalog-kb.test.ts)', email: `owner-sync-kb-test-${Date.now()}@example.invalid`, credential_group_id: groupId })
            .select('id')
            .single();
        if (ownerErr || !owner) throw new Error(`No se pudo crear owner: ${ownerErr?.message}`);
        ownerOrgId = owner.id;

        await supabaseAdmin.from('credential_groups').update({ owner_organization_id: ownerOrgId }).eq('id', groupId);

        const { data: catalog, error: catalogErr } = await supabaseAdmin
            .from('catalogs')
            .insert({ owner_organization_id: ownerOrgId, name: 'Catálogo (sync-catalog-kb.test.ts)' })
            .select('id')
            .single();
        if (catalogErr || !catalog) throw new Error(`No se pudo crear el catálogo: ${catalogErr?.message}`);
        catalogId = catalog.id;

        const saved = await setSecret(ownerOrgId, SECRET_KEYS.ELEVENLABS_API_KEY, API_KEY_VALUE);
        if (!saved) throw new Error('No se pudo guardar la credencial de prueba');
        clearSecretCache(ownerOrgId);
    });

    afterAll(async () => {
        await supabaseAdmin.from('catalogs').delete().eq('id', catalogId);
        await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', ownerOrgId);
        await supabaseAdmin.from('organizations').delete().eq('id', ownerOrgId);
        await supabaseAdmin.from('credential_groups').delete().eq('id', groupId);
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.mocked(createOrUpdateKbTextDocument).mockReset();
        vi.mocked(deleteKbDocument).mockReset();
        vi.mocked(triggerRagIndex).mockReset();
        vi.mocked(createKbFolder).mockReset();
        vi.mocked(getKbUsage).mockReset().mockResolvedValue(null);
    });

    async function createProduct(name: string, sku: string, opts: { isActive?: boolean } = {}) {
        const { data: product, error } = await supabaseAdmin
            .from('products')
            .insert({
                catalog_id: catalogId,
                name,
                category: 'Categoría de prueba',
                is_active: opts.isActive ?? true,
            })
            .select('id')
            .single();
        if (error || !product) throw new Error(`No se pudo crear producto: ${error?.message}`);

        const { error: variantErr } = await supabaseAdmin
            .from('product_variants')
            .insert({ product_id: product.id, catalog_id: catalogId, sku, presentation: 'única' });
        if (variantErr) throw new Error(`No se pudo crear variante: ${variantErr.message}`);

        return product.id as string;
    }

    it('sincroniza un producto pendiente: crea el documento, dispara rag-index, guarda kb_document_id/hash y marca sincronizado', async () => {
        const productId = await createProduct('Producto sincronizable', `SYNC-${Date.now()}-1`);
        vi.mocked(createKbFolder).mockResolvedValue({ folderId: 'folder-test' });
        vi.mocked(createOrUpdateKbTextDocument).mockResolvedValue({ documentId: `doc-${productId}` });
        vi.mocked(triggerRagIndex).mockResolvedValue(undefined);

        await syncCatalogKbHandler(buildFakeFastify(), buildJob({ credentialGroupId: groupId, ownerOrganizationId: ownerOrgId }));

        expect(createOrUpdateKbTextDocument).toHaveBeenCalledWith(expect.objectContaining({ existingDocumentId: null, folderId: 'folder-test' }));
        expect(triggerRagIndex).toHaveBeenCalledWith(API_KEY_VALUE, `doc-${productId}`);

        const row = await getSyncRow(productId, groupId);
        expect(row?.status).toBe('sincronizado');
        expect(row?.kb_document_id).toBe(`doc-${productId}`);
        expect(row?.synced_content_hash).toBeTruthy();
        expect(row?.synced_at).toBeTruthy();
        expect(row?.rag_indexed_at).toBeTruthy();
    });

    it('hash sin cambios respecto a la última sincronización: no vuelve a llamar a la API de ElevenLabs', async () => {
        const productId = await createProduct('Producto sin cambios', `SYNC-${Date.now()}-2`);

        const { data: variants } = await supabaseAdmin.from('product_variants').select('sku, presentation, is_active').eq('product_id', productId);
        const content = generateProductKbDocument(
            { name: 'Producto sin cambios', category: 'Categoría de prueba', activeComponents: null, suggestedUse: null, description: null, contraindications: null },
            (variants ?? []).map((v) => ({ sku: v.sku, presentation: v.presentation, isActive: v.is_active }))
        );
        const hash = computeKbDocumentHash(content);

        // status='pendiente', no 'error': un 'error' con attempts=0 tiene 1
        // minuto de backoff (2^0) y quedaría filtrado por isDueForRetry antes
        // de llegar al camino que esta prueba quiere ejercitar. 'pendiente'
        // siempre está listo de inmediato (ver describe "isDueForRetry"), y
        // es un caso igual de válido para "el hash no cambió, no hace falta
        // llamar a la API otra vez" (p. ej. el trigger de la migración 56 se
        // disparó por un campo que en la práctica no cambió el contenido).
        await supabaseAdmin
            .from('product_kb_sync')
            .update({ status: 'pendiente', kb_document_id: 'doc-ya-existente', synced_content_hash: hash })
            .eq('product_id', productId)
            .eq('credential_group_id', groupId);

        await syncCatalogKbHandler(buildFakeFastify(), buildJob({ credentialGroupId: groupId, ownerOrganizationId: ownerOrgId }));

        expect(createOrUpdateKbTextDocument).not.toHaveBeenCalled();
        expect(triggerRagIndex).not.toHaveBeenCalled();

        const row = await getSyncRow(productId, groupId);
        expect(row?.status).toBe('sincronizado');
        expect(row?.kb_document_id).toBe('doc-ya-existente');
    });

    it('backoff: un producto en error reciente (dentro de la ventana de backoff) NO se reprocesa todavía', async () => {
        const productId = await createProduct('Producto en backoff', `SYNC-${Date.now()}-3`);
        await supabaseAdmin
            .from('product_kb_sync')
            .update({ status: 'error', attempts: 3, updated_at: new Date().toISOString() }) // 2^3=8 min de backoff, recién falló
            .eq('product_id', productId)
            .eq('credential_group_id', groupId);

        vi.mocked(createOrUpdateKbTextDocument).mockResolvedValue({ documentId: 'no-deberia-llamarse' });

        await syncCatalogKbHandler(buildFakeFastify(), buildJob({ credentialGroupId: groupId, ownerOrganizationId: ownerOrgId }));

        expect(createOrUpdateKbTextDocument).not.toHaveBeenCalledWith(expect.objectContaining({}));
        const row = await getSyncRow(productId, groupId);
        expect(row?.status).toBe('error');
        expect(row?.attempts).toBe(3);
    });

    it('contraparte: un producto "pendiente" (nunca "error") siempre se reprocesa, sin depender de backoff', async () => {
        // El caso "backoff ya venció" para status='error' se prueba puro en
        // el describe "isDueForRetry" de arriba — product_kb_sync fuerza
        // updated_at=now() en cada UPDATE (trigger set_updated_at(), migración
        // 56), así que no se puede simular "hace tiempo" contra la base real.
        const productId = await createProduct('Producto pendiente simple', `SYNC-${Date.now()}-4`);

        vi.mocked(createKbFolder).mockResolvedValue({ folderId: 'folder-test' });
        vi.mocked(createOrUpdateKbTextDocument).mockResolvedValue({ documentId: `doc-${productId}` });
        vi.mocked(triggerRagIndex).mockResolvedValue(undefined);

        await syncCatalogKbHandler(buildFakeFastify(), buildJob({ credentialGroupId: groupId, ownerOrganizationId: ownerOrgId }));

        expect(createOrUpdateKbTextDocument).toHaveBeenCalled();
        const row = await getSyncRow(productId, groupId);
        expect(row?.status).toBe('sincronizado');
        expect(row?.attempts).toBe(0);
    });

    it('producto desactivado con documento existente: lo elimina de ElevenLabs y marca eliminado', async () => {
        const productId = await createProduct('Producto a desactivar', `SYNC-${Date.now()}-5`);
        await supabaseAdmin
            .from('product_kb_sync')
            .update({ status: 'sincronizado', kb_document_id: 'doc-a-borrar' })
            .eq('product_id', productId)
            .eq('credential_group_id', groupId);

        // Desactivar re-marca pendiente vía el trigger de la migración 56 BLOQUE
        // 8 — ese trigger solo toca status/updated_at, kb_document_id sigue
        // siendo 'doc-a-borrar'.
        await supabaseAdmin.from('products').update({ is_active: false }).eq('id', productId);

        vi.mocked(deleteKbDocument).mockResolvedValue(undefined);

        await syncCatalogKbHandler(buildFakeFastify(), buildJob({ credentialGroupId: groupId, ownerOrganizationId: ownerOrgId }));

        expect(deleteKbDocument).toHaveBeenCalledWith(API_KEY_VALUE, 'doc-a-borrar');
        expect(createOrUpdateKbTextDocument).not.toHaveBeenCalled();

        const row = await getSyncRow(productId, groupId);
        expect(row?.status).toBe('eliminado');
        expect(row?.kb_document_id).toBeNull();
    });

    it('contraparte: producto desactivado que NUNCA se sincronizó (sin documento) marca eliminado sin llamar a deleteKbDocument', async () => {
        const productId = await createProduct('Producto nunca sincronizado', `SYNC-${Date.now()}-6`, { isActive: false });

        await syncCatalogKbHandler(buildFakeFastify(), buildJob({ credentialGroupId: groupId, ownerOrganizationId: ownerOrgId }));

        expect(deleteKbDocument).not.toHaveBeenCalled();
        const row = await getSyncRow(productId, groupId);
        expect(row?.status).toBe('eliminado');
    });

    it('un producto que falla se marca error con attempts incrementado, sin tumbar el resto del lote', async () => {
        const failingProductId = await createProduct('Producto que falla', `SYNC-${Date.now()}-7`);
        const okProductId = await createProduct('Producto que sí sincroniza', `SYNC-${Date.now()}-8`);

        vi.mocked(createKbFolder).mockResolvedValue({ folderId: 'folder-test' });
        // Falla solo para failingProductId, distinguido por el contenido del
        // documento (incluye el nombre del producto).
        vi.mocked(createOrUpdateKbTextDocument).mockImplementation(async (params) => {
            if (params.content.includes('Producto que falla')) {
                throw new Error('ElevenLabs caído (simulado)');
            }
            return { documentId: `doc-${okProductId}` };
        });
        vi.mocked(triggerRagIndex).mockResolvedValue(undefined);

        await syncCatalogKbHandler(buildFakeFastify(), buildJob({ credentialGroupId: groupId, ownerOrganizationId: ownerOrgId }));

        const failingRow = await getSyncRow(failingProductId, groupId);
        expect(failingRow?.status).toBe('error');
        expect(failingRow?.attempts).toBe(1);
        expect(failingRow?.kb_document_id).toBeNull();

        const okRow = await getSyncRow(okProductId, groupId);
        expect(okRow?.status).toBe('sincronizado');
        expect(okRow?.kb_document_id).toBe(`doc-${okProductId}`);
    });

    describe('syncCatalogKbSweepHandler', () => {
        it('encola un job por cada grupo con al menos un producto pendiente/error', async () => {
            await createProduct('Producto para el sweep', `SYNC-${Date.now()}-9`);
            const sendSpy = vi.fn().mockResolvedValue('fake-job-id');
            const fastify = { ...buildFakeFastify(), pgBoss: { send: sendSpy } } as unknown as FastifyInstance;

            await syncCatalogKbSweepHandler(fastify);

            const calledWithThisGroup = sendSpy.mock.calls.some(
                (call) => call[1]?.credentialGroupId === groupId && call[1]?.ownerOrganizationId === ownerOrgId
            );
            expect(calledWithThisGroup).toBe(true);
        });
    });
});

/**
 * Prueba de integración pura contra la base real: verifica directamente el
 * trigger `mark_product_for_kb_sync()` (db/migrations/56_catalogo_productos.sql
 * BLOQUE 8), sin pasar por el job — la regla central de toda la Fase C.
 */
describe('db/migrations/56_catalogo_productos.sql — mark_product_for_kb_sync()', () => {
    let groupId: string;
    let ownerOrgId: string;
    let catalogId: string;
    let productId: string;
    let variantId: string;

    beforeAll(async () => {
        const { data: group } = await supabaseAdmin.from('credential_groups').insert({ name: 'Grupo (mark-kb-sync trigger test)' }).select('id').single();
        groupId = group!.id;
        const { data: owner } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Owner (mark-kb-sync trigger test)', email: `owner-mark-kb-sync-${Date.now()}@example.invalid`, credential_group_id: groupId })
            .select('id')
            .single();
        ownerOrgId = owner!.id;
        await supabaseAdmin.from('credential_groups').update({ owner_organization_id: ownerOrgId }).eq('id', groupId);
        const { data: catalog } = await supabaseAdmin
            .from('catalogs')
            .insert({ owner_organization_id: ownerOrgId, name: 'Catálogo (mark-kb-sync trigger test)' })
            .select('id')
            .single();
        catalogId = catalog!.id;
        const { data: product } = await supabaseAdmin
            .from('products')
            .insert({ catalog_id: catalogId, name: 'Producto trigger test', description: 'Descripción original' })
            .select('id')
            .single();
        productId = product!.id;
        const { data: variant } = await supabaseAdmin
            .from('product_variants')
            .insert({ product_id: productId, catalog_id: catalogId, sku: `TRIGGER-${Date.now()}`, price: 100 })
            .select('id')
            .single();
        variantId = variant!.id;

        // Confirmar sincronizado (estado post-sync, para poder distinguir "se re-marcó pendiente" de "ya estaba pendiente").
        await supabaseAdmin
            .from('product_kb_sync')
            .update({ status: 'sincronizado' })
            .eq('product_id', productId)
            .eq('credential_group_id', groupId);
    });

    afterAll(async () => {
        await supabaseAdmin.from('catalogs').delete().eq('id', catalogId);
        await supabaseAdmin.from('organizations').delete().eq('id', ownerOrgId);
        await supabaseAdmin.from('credential_groups').delete().eq('id', groupId);
    });

    it('un cambio de PRECIO no marca el producto para resincronización', async () => {
        await supabaseAdmin.from('product_variants').update({ price: 999 }).eq('id', variantId);

        const { data: row } = await supabaseAdmin
            .from('product_kb_sync')
            .select('status')
            .eq('product_id', productId)
            .eq('credential_group_id', groupId)
            .maybeSingle();
        expect(row?.status).toBe('sincronizado');
    });

    it('contraparte: un cambio de DESCRIPCIÓN sí marca el producto para resincronización', async () => {
        await supabaseAdmin.from('products').update({ description: 'Descripción cambiada' }).eq('id', productId);

        const { data: row } = await supabaseAdmin
            .from('product_kb_sync')
            .select('status')
            .eq('product_id', productId)
            .eq('credential_group_id', groupId)
            .maybeSingle();
        expect(row?.status).toBe('pendiente');
    });
});
