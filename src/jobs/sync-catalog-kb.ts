import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { getSecret } from '../services/secret-service.js';
import { SECRET_KEYS } from '../types/secret-keys.js';
import { KB_SYNC_STATUSES } from '../types/product-kb-sync-status.js';
import {
    generateProductKbDocument,
    computeKbDocumentHash,
    NoActiveVariantsError,
    type CatalogProductForKb,
    type CatalogVariantForKb,
} from '../services/catalog-kb-document.js';
import {
    createOrUpdateKbTextDocument,
    deleteKbDocument,
    triggerRagIndex,
    createKbFolder,
    getKbUsage,
    ElevenLabsKbError,
} from '../services/elevenlabs-kb-client.js';

export const SYNC_CATALOG_KB_SWEEP_QUEUE = 'sync-catalog-kb-sweep';
export const SYNC_CATALOG_KB_QUEUE = 'sync-catalog-kb';

// Backoff exponencial por intento: 2^attempts minutos, tope de 6 (64 min) —
// suficiente para no martillar la API de un proveedor caído sin dejar un
// producto reintentando indefinidamente cada 5 minutos.
const MAX_BACKOFF_ATTEMPTS = 6;
const BASE_BACKOFF_MINUTES = 2;

// FASE C.3: umbral informativo, no un límite duro — "eso se decide con
// datos, no de antemano" (docs/tasks/catalogo-productos-grupos-cred.md).
const KB_USAGE_WARNING_RATIO = 0.8;

export interface SyncCatalogKbJobData {
    credentialGroupId: string;
    ownerOrganizationId: string;
}

export interface PendingSyncRow {
    product_id: string;
    kb_document_id: string | null;
    synced_content_hash: string | null;
    status: string;
    attempts: number;
    updated_at: string;
}

interface ProductRow {
    id: string;
    catalog_id: string;
    name: string;
    category: string | null;
    active_components: string | null;
    suggested_use: string | null;
    description: string | null;
    contraindications: string | null;
    is_active: boolean;
}

/**
 * Sweep: un job por cada grupo de credenciales con al menos un producto
 * `pendiente`/`error`. Agrupar por GRUPO (no por producto) es lo que evita
 * reindexar cientos de veces durante una importación masiva — todos los
 * productos marcados en la misma ventana de 5 minutos se procesan juntos en
 * una sola ejecución del handler.
 */
export async function syncCatalogKbSweepHandler(fastify: FastifyInstance): Promise<void> {
    const { data: pendingGroups, error } = await fastify.supabaseAdmin
        .from('product_kb_sync')
        .select('credential_group_id')
        .in('status', [KB_SYNC_STATUSES.PENDIENTE, KB_SYNC_STATUSES.ERROR]);

    if (error) {
        throw new Error(`No se pudo listar credential_group_id pendientes de sincronización: ${error.message}`);
    }

    const groupIds = Array.from(new Set((pendingGroups ?? []).map((row) => row.credential_group_id as string)));
    if (groupIds.length === 0) return;

    const { data: groups, error: groupsError } = await fastify.supabaseAdmin
        .from('credential_groups')
        .select('id, owner_organization_id')
        .in('id', groupIds)
        .not('owner_organization_id', 'is', null);

    if (groupsError) {
        throw new Error(`No se pudo resolver owner_organization_id de los grupos pendientes: ${groupsError.message}`);
    }

    for (const group of groups ?? []) {
        await fastify.pgBoss.send(SYNC_CATALOG_KB_QUEUE, {
            credentialGroupId: group.id,
            ownerOrganizationId: group.owner_organization_id,
        });
    }

    fastify.log.info({ groupCount: (groups ?? []).length }, 'sync-catalog-kb-sweep: lotes encolados');
}

export function isDueForRetry(row: PendingSyncRow): boolean {
    if (row.status !== KB_SYNC_STATUSES.ERROR) return true;
    const backoffMinutes = BASE_BACKOFF_MINUTES ** Math.min(row.attempts, MAX_BACKOFF_ATTEMPTS);
    const nextRetryAt = new Date(row.updated_at).getTime() + backoffMinutes * 60 * 1000;
    return Date.now() >= nextRetryAt;
}

async function resolveCatalogFolderId(fastify: FastifyInstance, apiKey: string, catalogId: string): Promise<string | null> {
    const { data: catalog, error } = await fastify.supabaseAdmin
        .from('catalogs')
        .select('id, name, kb_folder_id')
        .eq('id', catalogId)
        .maybeSingle();

    if (error || !catalog) return null;
    if (catalog.kb_folder_id) return catalog.kb_folder_id as string;

    try {
        const { folderId } = await createKbFolder(apiKey, catalog.name);
        await fastify.supabaseAdmin.from('catalogs').update({ kb_folder_id: folderId }).eq('id', catalogId);
        return folderId;
    } catch (err) {
        fastify.log.warn(
            { catalogId, err: err instanceof Error ? err.message : String(err) },
            'sync-catalog-kb: no se pudo crear/resolver la carpeta de KB del catálogo, se sincroniza sin carpeta'
        );
        return null;
    }
}

async function markError(fastify: FastifyInstance, productId: string, credentialGroupId: string, attempts: number, message: string): Promise<void> {
    await fastify.supabaseAdmin
        .from('product_kb_sync')
        .update({ status: KB_SYNC_STATUSES.ERROR, attempts: attempts + 1, error: message })
        .eq('product_id', productId)
        .eq('credential_group_id', credentialGroupId);
}

/**
 * Procesa todos los productos `pendiente`/`error` (cuyo backoff ya venció)
 * de UN grupo de credenciales. Un producto que falla nunca tumba el lote
 * completo — se marca `error` con backoff y se sigue con el siguiente.
 */
export async function syncCatalogKbHandler(fastify: FastifyInstance, job: Job<SyncCatalogKbJobData>): Promise<void> {
    const { credentialGroupId, ownerOrganizationId } = job.data;

    const apiKey = await getSecret(ownerOrganizationId, SECRET_KEYS.ELEVENLABS_API_KEY);
    if (!apiKey) {
        fastify.log.info({ credentialGroupId, ownerOrganizationId }, 'sync-catalog-kb: sin credencial de ElevenLabs para el grupo, se omite');
        return;
    }

    const { data: syncRows, error: syncError } = await fastify.supabaseAdmin
        .from('product_kb_sync')
        .select('product_id, kb_document_id, synced_content_hash, status, attempts, updated_at')
        .eq('credential_group_id', credentialGroupId)
        .in('status', [KB_SYNC_STATUSES.PENDIENTE, KB_SYNC_STATUSES.ERROR]);

    if (syncError) {
        throw new Error(`No se pudo listar product_kb_sync del grupo ${credentialGroupId}: ${syncError.message}`);
    }

    const dueRows = (syncRows ?? []).filter((row) => isDueForRetry(row as PendingSyncRow));
    if (dueRows.length === 0) return;

    const productIds = dueRows.map((row) => row.product_id as string);
    const { data: products, error: productsError } = await fastify.supabaseAdmin
        .from('products')
        .select('id, catalog_id, name, category, active_components, suggested_use, description, contraindications, is_active')
        .in('id', productIds);

    if (productsError) {
        throw new Error(`No se pudo leer productos del grupo ${credentialGroupId}: ${productsError.message}`);
    }

    const productsById = new Map((products ?? []).map((p) => [p.id as string, p as ProductRow]));
    let processed = 0;

    for (const row of dueRows as PendingSyncRow[]) {
        const product = productsById.get(row.product_id);
        if (!product) continue; // producto borrado del todo: la fila de sync ya se fue por cascade, no debería llegar aquí

        try {
            if (!product.is_active) {
                if (row.kb_document_id) {
                    await deleteKbDocument(apiKey, row.kb_document_id);
                }
                await fastify.supabaseAdmin
                    .from('product_kb_sync')
                    .update({ status: KB_SYNC_STATUSES.ELIMINADO, kb_document_id: null, error: null })
                    .eq('product_id', row.product_id)
                    .eq('credential_group_id', credentialGroupId);
                processed++;
                continue;
            }

            const { data: variants, error: variantsError } = await fastify.supabaseAdmin
                .from('product_variants')
                .select('sku, presentation, is_active')
                .eq('product_id', row.product_id);

            if (variantsError) throw new Error(variantsError.message);

            const productForKb: CatalogProductForKb = {
                name: product.name,
                category: product.category,
                activeComponents: product.active_components,
                suggestedUse: product.suggested_use,
                description: product.description,
                contraindications: product.contraindications,
            };
            const variantsForKb: CatalogVariantForKb[] = (variants ?? []).map((v) => ({
                sku: v.sku as string,
                presentation: v.presentation as string | null,
                isActive: v.is_active as boolean,
            }));

            const content = generateProductKbDocument(productForKb, variantsForKb);
            const contentHash = computeKbDocumentHash(content);

            if (row.kb_document_id && row.synced_content_hash === contentHash) {
                // Contenido descriptivo sin cambios desde la última sincronización
                // (llegó aquí por haber quedado en 'error' antes, p. ej.) — no hace
                // falta volver a llamar a la API de ElevenLabs.
                await fastify.supabaseAdmin
                    .from('product_kb_sync')
                    .update({ status: KB_SYNC_STATUSES.SINCRONIZADO, error: null, attempts: 0 })
                    .eq('product_id', row.product_id)
                    .eq('credential_group_id', credentialGroupId);
                processed++;
                continue;
            }

            const folderId = await resolveCatalogFolderId(fastify, apiKey, product.catalog_id);
            const { documentId } = await createOrUpdateKbTextDocument({
                apiKey,
                existingDocumentId: row.kb_document_id,
                name: `SKU: ${variantsForKb.find((v) => v.isActive)?.sku ?? product.name}`,
                content,
                folderId,
            });
            await triggerRagIndex(apiKey, documentId);

            const now = new Date().toISOString();
            await fastify.supabaseAdmin
                .from('product_kb_sync')
                .update({
                    status: KB_SYNC_STATUSES.SINCRONIZADO,
                    kb_document_id: documentId,
                    synced_content_hash: contentHash,
                    synced_at: now,
                    rag_indexed_at: now,
                    error: null,
                    attempts: 0,
                })
                .eq('product_id', row.product_id)
                .eq('credential_group_id', credentialGroupId);
            processed++;
        } catch (err) {
            const message =
                err instanceof NoActiveVariantsError
                    ? err.message
                    : err instanceof ElevenLabsKbError
                      ? `ElevenLabs (${err.status}): ${err.message}`
                      : err instanceof Error
                        ? err.message
                        : String(err);
            fastify.log.warn({ credentialGroupId, productId: row.product_id, err: message }, 'sync-catalog-kb: producto falló, se marca error con backoff');
            await markError(fastify, row.product_id, credentialGroupId, row.attempts, message);
        }
    }

    fastify.log.info({ credentialGroupId, processed, total: dueRows.length }, 'sync-catalog-kb: lote procesado');

    // FASE C.3 — chequeo informativo, nunca bloquea la sincronización.
    const usage = await getKbUsage(apiKey);
    if (usage && usage.documentLimit && usage.documentCount / usage.documentLimit >= KB_USAGE_WARNING_RATIO) {
        fastify.log.warn(
            { credentialGroupId, documentCount: usage.documentCount, documentLimit: usage.documentLimit },
            'sync-catalog-kb: la knowledge base del grupo se acerca al límite de documentos del plan'
        );
    }
}

/**
 * Registra las colas y workers de pg-boss, y programa el sweep cada 5
 * minutos — el intervalo que naturalmente coalesce ráfagas de una
 * importación masiva en un solo lote por grupo.
 */
export async function registerSyncCatalogKbWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(SYNC_CATALOG_KB_SWEEP_QUEUE, { retryLimit: 3, retryBackoff: true });
    await fastify.pgBoss.createQueue(SYNC_CATALOG_KB_QUEUE, { retryLimit: 3, retryBackoff: true });

    await fastify.pgBoss.work(SYNC_CATALOG_KB_SWEEP_QUEUE, async () => {
        await syncCatalogKbSweepHandler(fastify);
    });

    await fastify.pgBoss.work<SyncCatalogKbJobData>(SYNC_CATALOG_KB_QUEUE, async ([job]) => {
        await syncCatalogKbHandler(fastify, job);
    });

    await fastify.pgBoss.schedule(SYNC_CATALOG_KB_SWEEP_QUEUE, '*/5 * * * *', null, { tz: 'UTC' });
}
