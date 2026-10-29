import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { TEST_EMAIL_DOMAIN, deleteTestOrganizations, deleteTestUsers } from './helpers/test-data-sweeper.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import catalogRoutes from '../src/routes/catalogs.js';
import plansRoutes from '../src/routes/plans.js';
import adminPlansRoutes from '../src/routes/admin/plans.js';
import { productsToolRoute } from '../src/routes/tools/products.js';
import { hasCatalogAccess, clearEntitlementsCache, setFeatureOverride } from '../src/services/entitlements.js';
import { FEATURE_KEYS } from '../src/types/feature-taxonomy.js';
import { setSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { buildImportPlan } from '../src/services/catalog-import-service.js';
import { CATALOG_IMPORT_MODES } from '../src/types/catalog-import.js';
import { generateProductKbDocument } from '../src/services/catalog-kb-document.js';
import { syncCatalogKbHandler, type SyncCatalogKbJobData } from '../src/jobs/sync-catalog-kb.js';
import type { Job } from 'pg-boss';

vi.mock('../src/services/elevenlabs-kb-client.js', async () => {
    const actual = await vi.importActual<typeof import('../src/services/elevenlabs-kb-client.js')>(
        '../src/services/elevenlabs-kb-client.js'
    );
    return {
        ...actual,
        createOrUpdateKbTextDocument: vi.fn().mockResolvedValue({ documentId: 'doc-kb-test' }),
        deleteKbDocument: vi.fn().mockResolvedValue(undefined),
        triggerRagIndex: vi.fn().mockResolvedValue(undefined),
        createKbFolder: vi.fn().mockResolvedValue({ folderId: 'folder-kb-test' }),
        getKbUsage: vi.fn().mockResolvedValue(null),
    };
});

import { createOrUpdateKbTextDocument } from '../src/services/elevenlabs-kb-client.js';

const env = validateEnv();
const TEST_TOOL_SECRET = 'b-b2-tool-secret';

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-b-b2-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
    });
    if (createErr || !created.user) throw new Error(`No se pudo crear usuario: ${createErr?.message}`);
    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) throw new Error(`No se pudo iniciar sesión: ${signInErr?.message}`);
    return { userId: created.user.id, jwt: session.session.access_token };
}

function createAuthenticatedSupabaseClient(jwt: string) {
    return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
    });
}

async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
    await app.register(supabasePlugin);
    await app.register(catalogRoutes);
    await app.register(plansRoutes);
    await app.register(adminPlansRoutes);
    await app.register(productsToolRoute);
    await app.ready();
    return app;
}

describe('Fase B & B2 — Catálogo con Tipos de Partida, Entitlements Híbridos y Puente de Planes', () => {
    let starterOwner: TestUser;
    let proOwner: TestUser;
    let starterOrgId: string;
    let proOrgId: string;
    let sharedOrgId: string;
    let proWebhookToken: string;

    beforeAll(async () => {
        starterOwner = await createTestUserWithJwt();
        proOwner = await createTestUserWithJwt();

        const { data: sOrg, error: sErr } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Starter Org B-B2',
            p_email: `starter-b-b2-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: starterOwner.userId,
        });
        if (sErr || !sOrg) throw new Error(`No se pudo crear starterOrg: ${sErr?.message}`);
        starterOrgId = sOrg.id;
        await supabaseAdmin.from('organizations').update({ plan_key: 'starter' }).eq('id', starterOrgId);

        proWebhookToken = `pro-b2-token-${Date.now()}`;
        const { data: pOrg, error: pErr } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Pro Org B-B2',
            p_email: `pro-b-b2-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: proOwner.userId,
        });
        if (pErr || !pOrg) throw new Error(`No se pudo crear proOrg: ${pErr?.message}`);
        proOrgId = pOrg.id;
        await supabaseAdmin
            .from('organizations')
            .update({ plan_key: 'pro', webhook_token: proWebhookToken, integration_settings: { tipoCambioUSD: 20 } })
            .eq('id', proOrgId);

        await setSecret(proOrgId, SECRET_KEYS.TOOL_WEBHOOK_SECRET, TEST_TOOL_SECRET);
        clearSecretCache(proOrgId);

        const { data: proOrgRow } = await supabaseAdmin
            .from('organizations')
            .select('credential_group_id')
            .eq('id', proOrgId)
            .single();

        const { data: shOrg, error: shErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Shared Sibling Org B-B2',
                email: `shared-b-b2-${crypto.randomUUID()}@example.invalid`,
                plan_key: 'pro',
                credential_group_id: proOrgRow!.credential_group_id,
                status: 'active',
            })
            .select('id')
            .single();
        if (shErr || !shOrg) throw new Error(`No se pudo crear sharedOrg: ${shErr?.message}`);
        sharedOrgId = shOrg.id;

        clearEntitlementsCache();
    });

    afterAll(async () => {
        // El catálogo administrado que vinculan estas pruebas pertenece a proOrgId
        // y cae en cascada al borrarla. Nunca se borra un vínculo ajeno (real).
        if (proOrgId) await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', proOrgId);
        await deleteTestOrganizations(supabaseAdmin, [sharedOrgId, proOrgId, starterOrgId]);
        await deleteTestUsers(supabaseAdmin, [starterOwner?.userId, proOwner?.userId]);
        clearEntitlementsCache();
    });

    describe('B.1 / B.2 — hasCatalogAccess y apertura del catálogo a plan pro (quotations sin product_rag)', () => {
        it('hasCatalogAccess devuelve false para starter y true para pro (quotations) y elite (product_rag)', async () => {
            clearEntitlementsCache();
            expect(await hasCatalogAccess(starterOrgId)).toBe(false);
            expect(await hasCatalogAccess(proOrgId)).toBe(true);

            // Si deshabilitamos quotations en pro pero habilitamos product_rag, sigue siendo true
            await setFeatureOverride(proOrgId, FEATURE_KEYS.QUOTATIONS, false, 'Prueba B.1 solo product_rag');
            await setFeatureOverride(proOrgId, FEATURE_KEYS.PRODUCT_RAG, true, 'Prueba B.1 solo product_rag');
            clearEntitlementsCache(proOrgId);
            expect(await hasCatalogAccess(proOrgId)).toBe(true);

            // Restaurar
            await supabaseAdmin.from('organization_features').delete().eq('organization_id', proOrgId);
            clearEntitlementsCache(proOrgId);
        });

        it('starter con manage_catalog recibe 403 en POST /api/organizations/:id/catalogs; pro recibe 201', async () => {
            const app = await buildApp();
            try {
                const resStarter = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${starterOrgId}/catalogs`,
                    headers: { authorization: `Bearer ${starterOwner.jwt}` },
                    payload: { name: 'Catálogo Starter Rechazado' },
                });
                expect(resStarter.statusCode).toBe(403);
                expect(resStarter.json().code).toBe('FEATURE_DISABLED');

                const resPro = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${proOrgId}/catalogs`,
                    headers: { authorization: `Bearer ${proOwner.jwt}` },
                    payload: { name: 'Catálogo Pro Permitido' },
                });
                expect(resPro.statusCode).toBe(201);
                const createdCatalogId = resPro.json().data.id;
                await supabaseAdmin.from('catalogs').delete().eq('id', createdCatalogId);
            } finally {
                await app.close();
            }
        });

        it('RLS (H3): cliente Supabase directo de starter con manage_catalog NO puede insertar en products; pro SÍ puede', async () => {
            const { data: starterCat } = await supabaseAdmin
                .from('catalogs')
                .insert({ owner_organization_id: starterOrgId, name: 'Catálogo RLS Starter' })
                .select('id')
                .single();

            const { data: proCat } = await supabaseAdmin
                .from('catalogs')
                .insert({ owner_organization_id: proOrgId, name: 'Catálogo RLS Pro' })
                .select('id')
                .single();

            try {
                const starterClient = createAuthenticatedSupabaseClient(starterOwner.jwt);
                const { error: starterInsertErr } = await starterClient
                    .from('products')
                    .insert({ catalog_id: starterCat!.id, name: 'Producto bloqueado por RLS en starter' });
                expect(starterInsertErr).not.toBeNull();

                const proClient = createAuthenticatedSupabaseClient(proOwner.jwt);
                const { data: proProduct, error: proInsertErr } = await proClient
                    .from('products')
                    .insert({ catalog_id: proCat!.id, name: 'Producto permitido por RLS en pro' })
                    .select('id')
                    .single();
                expect(proInsertErr).toBeNull();
                expect(proProduct?.id).toBeTruthy();
            } finally {
                await supabaseAdmin.from('catalogs').delete().eq('id', starterCat!.id);
                await supabaseAdmin.from('catalogs').delete().eq('id', proCat!.id);
            }
        });

        it('H2: organización en pro (quotations=true, product_rag=false) no llama a ElevenLabs en sync-catalog-kb', async () => {
            const { data: cat } = await supabaseAdmin
                .from('catalogs')
                .insert({ owner_organization_id: proOrgId, name: 'Catálogo Pro Sin RAG' })
                .select('id')
                .single();

            const { data: prod } = await supabaseAdmin
                .from('products')
                .insert({ catalog_id: cat!.id, name: 'Producto Pro Sin RAG' })
                .select('id')
                .single();

            const { data: proOrgRow } = await supabaseAdmin
                .from('organizations')
                .select('credential_group_id')
                .eq('id', proOrgId)
                .single();

            vi.mocked(createOrUpdateKbTextDocument).mockClear();

            const fakeFastify = {
                supabaseAdmin,
                log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
            } as unknown as FastifyInstance;

            const fakeJob = {
                id: 'job-h2-test',
                data: { credentialGroupId: proOrgRow!.credential_group_id, ownerOrganizationId: proOrgId },
            } as unknown as Job<SyncCatalogKbJobData>;

            try {
                await syncCatalogKbHandler(fakeFastify, fakeJob);
                expect(createOrUpdateKbTextDocument).not.toHaveBeenCalled();
            } finally {
                await supabaseAdmin.from('catalogs').delete().eq('id', cat!.id);
            }
        });
    });

    describe('B.4 / B2.1 — Desempate determinista en resolve_variant_for_org y omisión de availabilityText en no inventariables', () => {
        it('SKU duplicado en catálogo propio y compartido resuelve siempre la variante del catálogo propio', async () => {
            const dupSku = `DUP-SKU-${Date.now()}`;
            const { data: sharedCat } = await supabaseAdmin
                .from('catalogs')
                .insert({ owner_organization_id: sharedOrgId, name: 'Catálogo Hermano Compartido' })
                .select('id')
                .single();

            await supabaseAdmin.from('catalog_access').insert({
                catalog_id: sharedCat!.id,
                organization_id: proOrgId,
                can_edit: false,
            });

            const { data: ownCat } = await supabaseAdmin
                .from('catalogs')
                .insert({ owner_organization_id: proOrgId, name: 'Catálogo Propio Pro' })
                .select('id')
                .single();

            const { data: sharedProd } = await supabaseAdmin
                .from('products')
                .insert({ catalog_id: sharedCat!.id, name: 'Prod Compartido' })
                .select('id')
                .single();
            await supabaseAdmin.from('product_variants').insert({
                product_id: sharedProd!.id,
                catalog_id: sharedCat!.id,
                sku: dupSku,
                price: 999,
            });

            const { data: ownProd } = await supabaseAdmin
                .from('products')
                .insert({ catalog_id: ownCat!.id, name: 'Prod Propio' })
                .select('id')
                .single();
            const { data: ownVar } = await supabaseAdmin
                .from('product_variants')
                .insert({
                    product_id: ownProd!.id,
                    catalog_id: ownCat!.id,
                    sku: dupSku,
                    price: 111,
                })
                .select('id')
                .single();

            try {
                const { data: resolved, error } = await supabaseAdmin.rpc('resolve_variant_for_org', {
                    p_org_id: proOrgId,
                    p_sku: dupSku,
                });
                expect(error).toBeNull();
                expect(resolved).toHaveLength(1);
                expect(resolved![0].variant_id).toBe(ownVar!.id);
                expect(Number(resolved![0].price)).toBe(111);
            } finally {
                await supabaseAdmin.from('catalogs').delete().eq('id', ownCat!.id);
                await supabaseAdmin.from('catalogs').delete().eq('id', sharedCat!.id);
            }
        });

        it('tools/products omite availabilityText para servicio/plan e incluye availabilityText para producto', async () => {
            const { data: cat } = await supabaseAdmin
                .from('catalogs')
                .insert({ owner_organization_id: proOrgId, name: 'Catálogo Tools Tipos' })
                .select('id')
                .single();

            const { data: prodFisico } = await supabaseAdmin
                .from('products')
                .insert({ catalog_id: cat!.id, name: 'Producto Físico', item_type: 'producto' })
                .select('id')
                .single();
            const skuFisico = `FIS-${Date.now()}`;
            await supabaseAdmin.from('product_variants').insert({
                product_id: prodFisico!.id,
                catalog_id: cat!.id,
                sku: skuFisico,
                price: 250,
                stock_status: 'disponible',
            });

            const { data: prodServicio } = await supabaseAdmin
                .from('products')
                .insert({ catalog_id: cat!.id, name: 'Servicio Mensual', item_type: 'servicio' })
                .select('id')
                .single();
            const skuServicio = `SRV-${Date.now()}`;
            await supabaseAdmin.from('product_variants').insert({
                product_id: prodServicio!.id,
                catalog_id: cat!.id,
                sku: skuServicio,
                price: 1200,
                billing_period: 'mensual',
            });

            const app = await buildApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/tools/${proWebhookToken}/products`,
                    headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                    payload: { skus: [skuFisico, skuServicio] },
                });
                expect(response.statusCode).toBe(200);
                const results = response.json().results;
                const fisicoRes = results.find((r: { sku: string }) => r.sku === skuFisico);
                const servicioRes = results.find((r: { sku: string }) => r.sku === skuServicio);

                expect(fisicoRes.found).toBe(true);
                expect(fisicoRes.availabilityText).toBeTruthy();

                expect(servicioRes.found).toBe(true);
                expect(servicioRes.availabilityText).toBeUndefined();
            } finally {
                await app.close();
                await supabaseAdmin.from('catalogs').delete().eq('id', cat!.id);
            }
        });
    });

    describe('B2.1 — Importación y KB con item_type y billing_period', () => {
        it('buildImportPlan rechaza producto con stock_status=no_aplica y servicio con stock_status=disponible, y acepta combinaciones válidas', () => {
            const mapping = {
                sku: 'SKU',
                name: 'Nombre',
                itemType: 'Tipo',
                billingPeriod: 'Periodo',
                stockStatus: 'Existencia',
                satUnitKey: 'UnidadSAT',
                price: 'Precio',
            };

            const rows = [
                { SKU: 'P-ERR', Nombre: 'Prod Mal', Tipo: 'producto', Periodo: 'unico', Existencia: 'no_aplica', UnidadSAT: 'H87', Precio: '100' },
                { SKU: 'S-ERR', Nombre: 'Serv Mal', Tipo: 'servicio', Periodo: 'mensual', Existencia: 'disponible', UnidadSAT: 'E48', Precio: '500' },
                { SKU: 'P-OK', Nombre: 'Prod Bien', Tipo: 'producto', Periodo: 'unico', Existencia: 'disponible', UnidadSAT: 'H87', Precio: '100' },
                { SKU: 'S-OK', Nombre: 'Serv Bien', Tipo: 'servicio', Periodo: 'mensual', Existencia: '', UnidadSAT: 'E48', Precio: '500' },
            ];

            const plan = buildImportPlan(rows, mapping, CATALOG_IMPORT_MODES.COMPLETO, new Set());
            expect(plan.errors).toHaveLength(2);
            expect(plan.validRows).toHaveLength(2);
            expect(plan.validRows[0].fields.itemType).toBe('producto');
            expect(plan.validRows[1].fields.itemType).toBe('servicio');
            expect(plan.validRows[1].fields.billingPeriod).toBe('mensual');
            expect(plan.validRows[1].fields.satUnitKey).toBe('E48');
        });

        it('generateProductKbDocument incluye tipo y modalidad de cobro sin incluir precio', () => {
            const doc = generateProductKbDocument(
                {
                    name: 'Iguala de Soporte',
                    itemType: 'servicio',
                    category: 'Soporte',
                    activeComponents: null,
                    suggestedUse: null,
                    description: 'Atención prioritaria',
                    contraindications: null,
                },
                [{ sku: 'SOP-MENS', presentation: 'Mensual', isActive: true, billingPeriod: 'mensual' }]
            );
            expect(doc).toContain('Tipo: Servicio');
            expect(doc).toContain('mensual');
        });
    });

    describe('B2.2 / B2.3 / B2.4 / B2.5 — Puente de planes a catálogo administrado, paridad con Pricing y add-ons', () => {
        /**
         * El catálogo administrado es único por instalación. Si ya existe uno
         * cuya organización no es de prueba, es el vínculo real de esta base:
         * estas pruebas no pueden correr sin destruirlo, así que se omiten.
         */
        async function realBindingExists(): Promise<boolean> {
            const { data } = await supabaseAdmin
                .from('catalogs')
                .select('owner_organization_id, organizations!inner(email)')
                .eq('managed_source', 'datagol_plans')
                .maybeSingle();
            if (!data) return false;
            const owner = data.organizations as unknown as { email: string | null };
            return !owner.email?.toLowerCase().endsWith(TEST_EMAIL_DOMAIN);
        }

        it('sin catálogo vinculado, actualizar un plan no falla ni crea catálogo administrado', async (ctx) => {
            if (await realBindingExists()) ctx.skip();
            // Un vínculo restante de una corrida de prueba interrumpida sí se puede retirar.
            await supabaseAdmin.from('catalogs').delete().eq('managed_source', 'datagol_plans');

            const app = await buildApp();
            try {
                const statusBefore = await app.inject({
                    method: 'GET',
                    url: '/api/admin/plans/catalog-binding',
                    headers: { 'x-platform-admin': 'true' },
                });
                expect(statusBefore.statusCode).toBe(200);
                expect(statusBefore.json().data.bound).toBe(false);

                const { data: starterBefore } = await supabaseAdmin.from('plans').select('setup_fee_mxn').eq('key', 'starter').single();
                const patchRes = await app.inject({
                    method: 'PATCH',
                    url: '/api/admin/plans/starter',
                    headers: { 'x-platform-admin': 'true' },
                    payload: { setupFeeMxn: Number(starterBefore!.setup_fee_mxn) },
                });
                expect(patchRes.statusCode).toBe(200);

                const { data: managedCats } = await supabaseAdmin
                    .from('catalogs')
                    .select('id')
                    .eq('managed_source', 'datagol_plans');
                expect(managedCats ?? []).toHaveLength(0);
            } finally {
                await app.close();
            }
        });

        it('POST /api/admin/plans/catalog-binding crea el catálogo "Planes Datagol", proyecta todos los planes con paridad exacta con Pricing.tsx y actualiza en vivo al hacer PATCH', async (ctx) => {
            if (await realBindingExists()) ctx.skip();
            const app = await buildApp();
            try {
                const bindRes = await app.inject({
                    method: 'POST',
                    url: '/api/admin/plans/catalog-binding',
                    headers: { 'x-platform-admin': 'true' },
                    payload: { organizationId: proOrgId },
                });
                expect(bindRes.statusCode).toBe(200);
                const bindData = bindRes.json().data;
                expect(bindData.bound).toBe(true);
                expect(bindData.catalogId).toBeTruthy();
                expect(bindData.ownerOrganizationId).toBe(proOrgId);
                expect(bindData.projectedProductsCount).toBeGreaterThanOrEqual(4);

                const catalogId = bindData.catalogId as string;

                // Verificar paridad con Pricing.tsx para todos los planes con monthly_fee_mxn no nulo
                const { data: allPlans } = await supabaseAdmin.from('plans').select('*');
                for (const plan of allPlans ?? []) {
                    if (plan.monthly_fee_mxn !== null) {
                        const discount = Number(plan.annual_retainer_discount_pct ?? 0.2);
                        const expectedAnnualMonthly = Math.round(Number(plan.monthly_fee_mxn) * (1 - discount));
                        const skuAnual = `MANT-${String(plan.key).toUpperCase()}-ANUAL`;
                        const { data: annualVar } = await supabaseAdmin
                            .from('product_variants')
                            .select('price')
                            .eq('catalog_id', catalogId)
                            .eq('sku', skuAnual)
                            .single();
                        expect(Number(annualVar!.price) / 12).toBe(expectedAnnualMonthly);
                    } else {
                        // Plan con iguala a medida (ej. enterprise): variantes de mantenimiento tienen price = null
                        const skuMensual = `MANT-${String(plan.key).toUpperCase()}-MENSUAL`;
                        const { data: mensVar } = await supabaseAdmin
                            .from('product_variants')
                            .select('price')
                            .eq('catalog_id', catalogId)
                            .eq('sku', skuMensual)
                            .single();
                        expect(mensVar!.price).toBeNull();
                    }
                }

                // Cambiar setup_fee_mxn en plans vía PATCH /api/admin/plans/:key actualiza PLAN-STARTER en la misma transacción y registra source='plans_sync'
                const { data: starterOrig } = await supabaseAdmin
                    .from('plans')
                    .select('setup_fee_mxn, annual_retainer_discount_pct')
                    .eq('key', 'starter')
                    .single();
                const newFee = Number(starterOrig!.setup_fee_mxn) + 100;

                try {
                    const patchRes = await app.inject({
                        method: 'PATCH',
                        url: '/api/admin/plans/starter',
                        headers: { 'x-platform-admin': 'true' },
                        payload: { setupFeeMxn: newFee, annualRetainerDiscountPct: 0.25 },
                    });
                    expect(patchRes.statusCode).toBe(200);

                    const { data: starterVar } = await supabaseAdmin
                        .from('product_variants')
                        .select('id, price')
                        .eq('catalog_id', catalogId)
                        .eq('sku', 'PLAN-STARTER')
                        .single();
                    expect(Number(starterVar!.price)).toBe(newFee);

                    const { data: historyRow } = await supabaseAdmin
                        .from('variant_price_history')
                        .select('source, price')
                        .eq('variant_id', starterVar!.id)
                        .order('changed_at', { ascending: false })
                        .limit(1)
                        .single();
                    expect(historyRow?.source).toBe('plans_sync');
                    expect(Number(historyRow?.price)).toBe(newFee);
                } finally {
                    await supabaseAdmin
                        .from('plans')
                        .update({
                            setup_fee_mxn: starterOrig!.setup_fee_mxn,
                            annual_retainer_discount_pct: starterOrig!.annual_retainer_discount_pct,
                        })
                        .eq('key', 'starter');
                }

                // Edición directa (rol authenticated) del precio de una variante administrada → rechazada; de sat_unit_key → aceptada
                const proClient = createAuthenticatedSupabaseClient(proOwner.jwt);
                const { data: managedVar } = await supabaseAdmin
                    .from('product_variants')
                    .select('id')
                    .eq('catalog_id', catalogId)
                    .eq('sku', 'PLAN-STARTER')
                    .single();

                const { error: directPriceErr } = await proClient
                    .from('product_variants')
                    .update({ price: 12345 })
                    .eq('id', managedVar!.id);
                expect(directPriceErr).not.toBeNull();
                expect(directPriceErr?.message).toContain('Este campo se administra desde Planes');

                const { error: directSatErr } = await proClient
                    .from('product_variants')
                    .update({ sat_unit_key: 'E48' })
                    .eq('id', managedVar!.id);
                expect(directSatErr).toBeNull();

                // GET /api/plans/public incluye annualDiscountPct y catalogRefs
                const pubRes = await app.inject({
                    method: 'GET',
                    url: `/api/plans/public?organizationId=${proOrgId}`,
                });
                expect(pubRes.statusCode).toBe(200);
                const pubBody = pubRes.json();
                const starterPub = pubBody.data.find((p: { key: string }) => p.key === 'starter');
                expect(typeof starterPub.annualDiscountPct).toBe('number');
                expect(starterPub.catalogRefs).toEqual({
                    setupSku: 'PLAN-STARTER',
                    monthlySku: 'MANT-STARTER-MENSUAL',
                    annualSku: 'MANT-STARTER-ANUAL',
                });
            } finally {
                await app.close();
            }
        });

        it('B2.5 — GET /api/plans/public/addons devuelve solo servicios category=addon de catálogos no administrados e incluye tipoCambioUsd', async () => {
            const { data: addonCat } = await supabaseAdmin
                .from('catalogs')
                .insert({ owner_organization_id: proOrgId, name: 'Catálogo Add-ons Pro' })
                .select('id')
                .single();

            const { data: addonProd } = await supabaseAdmin
                .from('products')
                .insert({
                    catalog_id: addonCat!.id,
                    name: 'Clonación de Voz Profesional',
                    category: 'addon',
                    item_type: 'servicio',
                    description: 'Clonación de voz dedicada',
                })
                .select('id')
                .single();

            await supabaseAdmin.from('product_variants').insert({
                product_id: addonProd!.id,
                catalog_id: addonCat!.id,
                sku: `ADDON-VOZ-${Date.now()}`,
                presentation: 'Pago único',
                price: 3500,
                billing_period: 'unico',
            });

            const app = await buildApp();
            try {
                const res = await app.inject({
                    method: 'GET',
                    url: `/api/plans/public/addons?organizationId=${proOrgId}`,
                });
                expect(res.statusCode).toBe(200);
                const body = res.json();
                expect(body.success).toBe(true);
                expect(body.tipoCambioUsd).toBe(20);
                expect(body.data.some((item: { name: string }) => item.name === 'Clonación de Voz Profesional')).toBe(true);
                // Nunca expone productos del catálogo administrado datagol_plans
                expect(body.data.some((item: { name: string }) => item.name.startsWith('Mantenimiento '))).toBe(false);
            } finally {
                await app.close();
                await supabaseAdmin.from('catalogs').delete().eq('id', addonCat!.id);
            }
        });
    });
});
