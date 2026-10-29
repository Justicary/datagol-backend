import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { deleteTestOrganizations } from './helpers/test-data-sweeper.js';
import supabasePlugin from '../src/plugins/supabase.js';
import { toolRoutes } from '../src/routes/tools/index.js';
import { setSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { clearEntitlementsCache } from '../src/services/entitlements.js';
import { getAuthorizedAgentTools } from '../src/services/agent-provisioning.js';
import {
    QUOTATION_SYSTEM_PROMPT_SNIPPET,
    injectQuotationsSectionIntoPrompt,
} from '../src/lib/agent-prompts.js';

const TOOL_SECRET_A = 'quot-tools-secret-a';
const TOOL_SECRET_B = 'quot-tools-secret-b';
const TOOL_SECRET_STARTER = 'quot-tools-secret-starter';

async function buildToolsApp(pgBossSendSpy = vi.fn().mockResolvedValue('job-1')): Promise<{
    app: FastifyInstance;
    pgBossSendSpy: ReturnType<typeof vi.fn>;
}> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    app.decorate('pgBoss', { send: pgBossSendSpy } as unknown as FastifyInstance['pgBoss']);
    await app.register(toolRoutes);
    await app.ready();
    return { app, pgBossSendSpy };
}

describe('Fase D — Tools en Vivo de Cotizaciones, Provisión y Prompt', () => {
    let orgAId: string;
    let orgBId: string;
    let starterOrgId: string;
    let tokenA: string;
    let tokenB: string;
    let tokenStarter: string;
    let catalogAId: string;
    let catalogBId: string;

    const SKU_PROD_A = `QT-PROD-A-${Date.now()}`;
    const SKU_SERV_A = `QT-SERV-A-${Date.now()}`;
    const SKU_PLAN_A = `QT-PLAN-A-${Date.now()}`;
    const SKU_MANT_A = `QT-MANT-A-${Date.now()}`;
    const SKU_CUSTOM_A = `QT-CUST-A-${Date.now()}`;
    const SKU_AGOTADO_A = `QT-AGOT-A-${Date.now()}`;
    const SKU_PROD_B = `QT-PROD-B-${Date.now()}`;
    let varProdAId: string;

    beforeAll(async () => {
        tokenA = `qt-token-a-${Date.now()}`;
        tokenB = `qt-token-b-${Date.now()}`;
        tokenStarter = `qt-token-starter-${Date.now()}`;

        const { data: orgA, error: errA } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org A Quot Tools',
                email: `org-a-qt-${crypto.randomUUID()}@example.invalid`,
                plan_key: 'pro',
                webhook_token: tokenA,
                status: 'active',
            })
            .select('id')
            .single();
        if (errA || !orgA) throw new Error(`Error creando orgA: ${errA?.message}`);
        orgAId = orgA.id;

        const { data: orgB, error: errB } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org B Quot Tools',
                email: `org-b-qt-${crypto.randomUUID()}@example.invalid`,
                plan_key: 'pro',
                webhook_token: tokenB,
                status: 'active',
            })
            .select('id')
            .single();
        if (errB || !orgB) throw new Error(`Error creando orgB: ${errB?.message}`);
        orgBId = orgB.id;

        const { data: orgS, error: errS } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org Starter Quot Tools',
                email: `org-s-qt-${crypto.randomUUID()}@example.invalid`,
                plan_key: 'starter',
                webhook_token: tokenStarter,
                status: 'active',
            })
            .select('id')
            .single();
        if (errS || !orgS) throw new Error(`Error creando starterOrg: ${errS?.message}`);
        starterOrgId = orgS.id;

        await setSecret(orgAId, SECRET_KEYS.TOOL_WEBHOOK_SECRET, TOOL_SECRET_A);
        await setSecret(orgBId, SECRET_KEYS.TOOL_WEBHOOK_SECRET, TOOL_SECRET_B);
        await setSecret(starterOrgId, SECRET_KEYS.TOOL_WEBHOOK_SECRET, TOOL_SECRET_STARTER);
        clearSecretCache(orgAId);
        clearSecretCache(orgBId);
        clearSecretCache(starterOrgId);
        clearEntitlementsCache();

        const { data: catA } = await supabaseAdmin
            .from('catalogs')
            .insert({ owner_organization_id: orgAId, name: 'Catálogo Org A Quot' })
            .select('id')
            .single();
        catalogAId = catA!.id;

        const { data: catB } = await supabaseAdmin
            .from('catalogs')
            .insert({ owner_organization_id: orgBId, name: 'Catálogo Org B Quot' })
            .select('id')
            .single();
        catalogBId = catB!.id;

        // Producto físico en A
        const { data: pProdA } = await supabaseAdmin
            .from('products')
            .insert({
                catalog_id: catalogAId,
                name: 'Taladro Industrial Percutor',
                keywords: 'taladro percutor herramienta',
                item_type: 'producto',
            })
            .select('id')
            .single();
        const { data: vProdA } = await supabaseAdmin
            .from('product_variants')
            .insert({
                product_id: pProdA!.id,
                catalog_id: catalogAId,
                sku: SKU_PROD_A,
                presentation: 'Maletín 800W',
                price: 2000,
                currency: 'MXN',
                price_includes_tax: false,
                tax_rate: 0.16,
                stock_status: 'disponible',
            })
            .select('id')
            .single();
        varProdAId = vProdA!.id;

        // Servicio mensual en A
        const { data: pServA } = await supabaseAdmin
            .from('products')
            .insert({
                catalog_id: catalogAId,
                name: 'Póliza de Mantenimiento Preventivo',
                keywords: 'poliza soporte mantenimiento',
                item_type: 'servicio',
            })
            .select('id')
            .single();
        await supabaseAdmin.from('product_variants').insert({
            product_id: pServA!.id,
            catalog_id: catalogAId,
            sku: SKU_SERV_A,
            presentation: 'Mensual',
            price: 1500,
            currency: 'MXN',
            price_includes_tax: false,
            tax_rate: 0.16,
            billing_period: 'mensual',
        });

        // Plan con su complemento de mantenimiento en A
        const { data: pPlanA } = await supabaseAdmin
            .from('products')
            .insert({
                catalog_id: catalogAId,
                name: 'Plan Empresarial Voz',
                keywords: 'plan empresarial voz',
                item_type: 'plan',
            })
            .select('id')
            .single();
        await supabaseAdmin.from('product_variants').insert({
            product_id: pPlanA!.id,
            catalog_id: catalogAId,
            sku: SKU_PLAN_A,
            presentation: 'Setup inicial',
            price: 25000,
            currency: 'MXN',
            price_includes_tax: false,
            tax_rate: 0.16,
            billing_period: 'unico',
        });

        const { data: pMantA } = await supabaseAdmin
            .from('products')
            .insert({
                catalog_id: catalogAId,
                name: 'Mantenimiento Plan Empresarial Voz',
                item_type: 'servicio',
                bundle_parent_id: pPlanA!.id,
            })
            .select('id')
            .single();
        await supabaseAdmin.from('product_variants').insert({
            product_id: pMantA!.id,
            catalog_id: catalogAId,
            sku: SKU_MANT_A,
            presentation: 'Iguala mensual',
            price: 3500,
            currency: 'MXN',
            price_includes_tax: false,
            tax_rate: 0.16,
            billing_period: 'mensual',
        });

        // Servicio "a medida" (price = null) y producto agotado en A
        const { data: pCustA } = await supabaseAdmin
            .from('products')
            .insert({ catalog_id: catalogAId, name: 'Desarrollo Enterprise A Medida', item_type: 'servicio' })
            .select('id')
            .single();
        await supabaseAdmin.from('product_variants').insert({
            product_id: pCustA!.id,
            catalog_id: catalogAId,
            sku: SKU_CUSTOM_A,
            price: null,
            billing_period: 'mensual',
        });

        const { data: pAgotA } = await supabaseAdmin
            .from('products')
            .insert({ catalog_id: catalogAId, name: 'Generador Agotado', item_type: 'producto' })
            .select('id')
            .single();
        await supabaseAdmin.from('product_variants').insert({
            product_id: pAgotA!.id,
            catalog_id: catalogAId,
            sku: SKU_AGOTADO_A,
            price: 8000,
            stock_status: 'agotado',
        });

        // Producto exclusivo de Org B
        const { data: pProdB } = await supabaseAdmin
            .from('products')
            .insert({ catalog_id: catalogBId, name: 'Compresor Exclusivo OrgB', item_type: 'producto' })
            .select('id')
            .single();
        await supabaseAdmin.from('product_variants').insert({
            product_id: pProdB!.id,
            catalog_id: catalogBId,
            sku: SKU_PROD_B,
            price: 5000,
            stock_status: 'disponible',
        });
    });

    afterAll(async () => {
        for (const id of [orgAId, orgBId, starterOrgId]) {
            if (!id) continue;
            await supabaseAdmin.from('quotations').delete().eq('organization_id', id);
            await supabaseAdmin.from('contacts').delete().eq('organization_id', id);
            await supabaseAdmin.from('catalogs').delete().eq('owner_organization_id', id);
            await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', id);
        }
        await deleteTestOrganizations(supabaseAdmin, [orgAId, orgBId, starterOrgId]);
        clearEntitlementsCache();
    });

    describe('Provisión de tools y prompt de cotizaciones', () => {
        it('starter NO expone tools de cotización; pro SÍ expone las 5 tools con requiredFeature="quotations"', async () => {
            const starterTools = await getAuthorizedAgentTools(starterOrgId);
            expect(starterTools.some((t) => t.name.startsWith('quotation_'))).toBe(false);

            const proTools = await getAuthorizedAgentTools(orgAId);
            const quotToolNames = proTools.filter((t) => t.requiredFeature === 'quotations').map((t) => t.name);
            expect(quotToolNames).toEqual(
                expect.arrayContaining([
                    'quotation_search',
                    'quotation_cart_set_item',
                    'quotation_cart_remove_item',
                    'quotation_cart_view',
                    'quotation_finalize',
                ])
            );
        });

        it('injectQuotationsSectionIntoPrompt inyecta o reemplaza el bloque COTIZACIONES: sin duplicar', () => {
            const basePrompt = 'Eres un asistente amable.\n\nPLANES:\nPlan Starter.';
            const withQuot = injectQuotationsSectionIntoPrompt(basePrompt);
            expect(withQuot).toContain('COTIZACIONES:');
            expect(withQuot).toContain(QUOTATION_SYSTEM_PROMPT_SNIPPET);

            const reInjected = injectQuotationsSectionIntoPrompt(withQuot, 'COTIZACIONES:\nRegla personalizada.');
            expect(reInjected).toContain('Regla personalizada.');
            expect(reInjected.match(/COTIZACIONES:/g)?.length).toBe(1);
        });
    });

    describe('Feature deshabilitada y búsqueda de catálogo (search)', () => {
        it('starter sin feature quotations recibe HTTP 200 degradado verbalizable', async () => {
            const { app } = await buildToolsApp();
            try {
                const res = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenStarter}/quotation/search`,
                    headers: { 'x-tool-secret': TOOL_SECRET_STARTER },
                    payload: { query: 'taladro' },
                });
                expect(res.statusCode).toBe(200);
                expect(res.json().results).toEqual([]);
                expect(res.json().message).toContain('No puedo armar cotizaciones en este momento');
            } finally {
                await app.close();
            }
        });

        it('search en Org A encuentra productos/planes propios, omite availabilityText en servicios/planes, incluye maintenanceSku en planes y NUNCA devuelve productos de Org B', async () => {
            const { app } = await buildToolsApp();
            try {
                const resProd = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/search`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: { query: 'Taladro', limit: 3 },
                });
                expect(resProd.statusCode).toBe(200);
                const prodItem = resProd.json().results.find((r: { sku: string }) => r.sku === SKU_PROD_A);
                expect(prodItem).toBeDefined();
                expect(prodItem.availabilityText).toBeTruthy();

                const resPlan = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/search`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: { query: 'Plan Empresarial', limit: 3 },
                });
                const planItem = resPlan.json().results.find((r: { sku: string }) => r.sku === SKU_PLAN_A);
                expect(planItem).toBeDefined();
                expect(planItem.availabilityText).toBeUndefined();
                expect(planItem.maintenanceSku).toBe(SKU_MANT_A);

                const resCross = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/search`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: { query: 'Compresor Exclusivo OrgB', limit: 3 },
                });
                expect(resCross.json().results).toHaveLength(0);
            } finally {
                await app.close();
            }
        });
    });

    describe('Aislamiento multi-tenant, continuidad por contacto (D2) y mitigación web', () => {
        it('token de A con teléfono de un contacto que existe en B crea contacto y carrito en A sin tocar el de B', async () => {
            const sharedPhone = '+525511223344';
            const { data: contactB } = await supabaseAdmin
                .from('contacts')
                .insert({
                    organization_id: orgBId,
                    full_name: 'Contacto Exclusivo B',
                    phone_e164: sharedPhone,
                })
                .select('id')
                .single();

            const { app } = await buildToolsApp();
            try {
                const res = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/set-item`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: {
                        conversationId: 'conv-iso-1',
                        customerPhone: sharedPhone,
                        customerName: 'Contacto en A',
                        sku: SKU_PROD_A,
                        quantity: 1,
                    },
                });
                expect(res.statusCode).toBe(200);
                expect(res.json().ok).toBe(true);

                // En B no existe ningún carrito
                const { data: bQuotations } = await supabaseAdmin
                    .from('quotations')
                    .select('id')
                    .eq('organization_id', orgBId);
                expect(bQuotations ?? []).toHaveLength(0);

                // El carrito creado en A pertenece a un contact_id de A, distinto de contactB.id
                const { data: aQuotation } = await supabaseAdmin
                    .from('quotations')
                    .select('contact_id')
                    .eq('id', res.json().quotationId)
                    .single();
                expect(aQuotation?.contact_id).not.toBe(contactB!.id);
            } finally {
                await app.close();
            }
        });

        it('sin teléfono ni correo pide un dato de contacto y no crea carrito anónimo', async () => {
            const { app } = await buildToolsApp();
            try {
                const res = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/set-item`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: {
                        conversationId: 'conv-anon',
                        sku: SKU_PROD_A,
                        quantity: 1,
                    },
                });
                expect(res.statusCode).toBe(200);
                expect(res.json().ok).toBe(false);
                expect(res.json().message).toMatch(/teléfono|correo/i);
            } finally {
                await app.close();
            }
        });

        it('continuidad D2: conversación 1 agrega 2 partidas (incluyendo plan con suggestedComplement); conversación 2 retoma con resumed=true; canal web NO retoma carrito creado en voz solo con email', async () => {
            const phone = '+525599887766';
            const email = 'cliente-d2@example.invalid';
            const { app } = await buildToolsApp();
            try {
                // Conversación 1 (voz) agrega producto y plan
                const r1 = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/set-item`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: {
                        conversationId: 'conv-d2-1',
                        channel: 'voz',
                        customerPhone: phone,
                        customerEmail: email,
                        customerName: 'Laura D2',
                        sku: SKU_PROD_A,
                        quantity: 2,
                    },
                });
                expect(r1.json().ok).toBe(true);

                const r2 = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/set-item`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: {
                        conversationId: 'conv-d2-1',
                        channel: 'voz',
                        customerPhone: phone,
                        sku: SKU_PLAN_A,
                        quantity: 1,
                    },
                });
                const body2 = r2.json();
                expect(body2.ok).toBe(true);
                expect(body2.items).toHaveLength(2);
                // Plan sugiere complemento de mantenimiento pero NO lo agrega solo
                expect(body2.suggestedComplement).toMatchObject({ sku: SKU_MANT_A });

                // Conversación 2 (whatsapp, otro conversationId, mismo teléfono) -> view devuelve resumed=true
                const rView = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/view`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: {
                        conversationId: 'conv-d2-2',
                        channel: 'whatsapp',
                        customerPhone: phone,
                    },
                });
                const viewBody = rView.json();
                expect(viewBody.ok).toBe(true);
                expect(viewBody.resumed).toBe(true);
                expect(viewBody.items).toHaveLength(2);
                expect(viewBody.spokenSummary).toContain('Tenía guardada una cotización');

                // Mitigación canal web: view en canal web solo con email NO retoma un carrito cuyo last_channel no es web
                const rWebView = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/view`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: {
                        conversationId: 'conv-d2-web',
                        channel: 'web',
                        customerEmail: email,
                    },
                });
                expect(rWebView.json().items).toHaveLength(0);
                expect(rWebView.json().resumed).toBe(false);

                // Carrito marcado como abandonada se reabre al volver el contacto por voz/whatsapp
                await supabaseAdmin
                    .from('quotations')
                    .update({ status: 'abandonada' })
                    .eq('id', body2.quotationId);

                const rReopen = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/view`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: {
                        conversationId: 'conv-d2-3',
                        channel: 'voz',
                        customerPhone: phone,
                    },
                });
                expect(rReopen.json().resumed).toBe(true);
                expect(rReopen.json().items).toHaveLength(2);
            } finally {
                await app.close();
            }
        });

        it('dos set-item concurrentes para un contacto nuevo crean un solo borrador', async () => {
            const concurrentPhone = '+525544332211';
            const { app } = await buildToolsApp();
            try {
                const [res1, res2] = await Promise.all([
                    app.inject({
                        method: 'POST',
                        url: `/tools/${tokenA}/quotation/cart/set-item`,
                        headers: { 'x-tool-secret': TOOL_SECRET_A },
                        payload: {
                            conversationId: 'conv-conc-1',
                            customerPhone: concurrentPhone,
                            sku: SKU_PROD_A,
                            quantity: 1,
                        },
                    }),
                    app.inject({
                        method: 'POST',
                        url: `/tools/${tokenA}/quotation/cart/set-item`,
                        headers: { 'x-tool-secret': TOOL_SECRET_A },
                        payload: {
                            conversationId: 'conv-conc-1',
                            customerPhone: concurrentPhone,
                            sku: SKU_SERV_A,
                            quantity: 1,
                        },
                    }),
                ]);
                expect(res1.json().ok).toBe(true);
                expect(res2.json().ok).toBe(true);
                expect(res1.json().quotationId).toBe(res2.json().quotationId);
            } finally {
                await app.close();
            }
        });

        it('rechaza verbalizablemente variantes con precio null ("a medida") o agotadas, y elimina partida con quantity=0 o remove-item', async () => {
            const phone = '+525566778899';
            const { app } = await buildToolsApp();
            try {
                const customRes = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/set-item`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: {
                        conversationId: 'conv-custom',
                        customerPhone: phone,
                        sku: SKU_CUSTOM_A,
                        quantity: 1,
                    },
                });
                expect(customRes.statusCode).toBe(200);
                expect(customRes.json().ok).toBe(false);
                expect(customRes.json().message).toContain('a medida');

                const agotadoRes = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/set-item`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: {
                        conversationId: 'conv-custom',
                        customerPhone: phone,
                        sku: SKU_AGOTADO_A,
                        quantity: 1,
                    },
                });
                expect(agotadoRes.statusCode).toBe(200);
                expect(agotadoRes.json().ok).toBe(false);
                expect(agotadoRes.json().message).toContain('agotado');

                // Agregar 2 partidas válidas y eliminar una con remove-item y otra con quantity=0
                await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/set-item`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: { conversationId: 'conv-rem', customerPhone: phone, sku: SKU_PROD_A, quantity: 2 },
                });
                await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/set-item`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: { conversationId: 'conv-rem', customerPhone: phone, sku: SKU_SERV_A, quantity: 1 },
                });

                const remRes = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/remove-item`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: { conversationId: 'conv-rem', customerPhone: phone, sku: SKU_PROD_A },
                });
                expect(remRes.json().items).toHaveLength(1);

                const zeroRes = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/set-item`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: { conversationId: 'conv-rem', customerPhone: phone, sku: SKU_SERV_A, quantity: 0 },
                });
                expect(zeroRes.json().items).toHaveLength(0);
            } finally {
                await app.close();
            }
        });
    });

    describe('Emisión (finalize): cambio de precio, idempotencia, nuevo carrito post-emisión y folios concurrentes', () => {
        it('detecta priceChanges entre set-item y finalize, emite con folio, es idempotente en reintento, y un set-item posterior abre un carrito nuevo', async () => {
            const phone = '+525512349876';
            const email = 'emit-test@example.invalid';
            const { app, pgBossSendSpy } = await buildToolsApp();
            try {
                const setRes = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/set-item`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: {
                        conversationId: 'conv-emit-1',
                        customerPhone: phone,
                        sku: SKU_PROD_A,
                        quantity: 1,
                    },
                });
                const firstQuotationId = setRes.json().quotationId;

                // Pedir envío por email sin proporcionar email falla amablemente antes de emitir
                const missingEmailRes = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/finalize`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: {
                        conversationId: 'conv-emit-1',
                        customerPhone: phone,
                        customerName: 'Roberto Emisión',
                        channels: ['email'],
                    },
                });
                expect(missingEmailRes.json().ok).toBe(false);
                expect(missingEmailRes.json().message).toContain('correo');

                // Cambiar precio en catálogo antes de finalize
                await supabaseAdmin.from('product_variants').update({ price: 2200 }).eq('id', varProdAId);

                const finRes = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/finalize`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: {
                        conversationId: 'conv-emit-1',
                        customerPhone: phone,
                        customerEmail: email,
                        customerName: 'Roberto Emisión',
                        channels: ['email', 'whatsapp'],
                    },
                });
                const finBody = finRes.json();
                expect(finBody.ok).toBe(true);
                expect(finBody.folio).toMatch(/^COT-\d{4}-\d{6}$/);
                expect(finBody.priceChanges).toHaveLength(1);
                expect(finBody.priceChanges[0]).toMatchObject({
                    sku: SKU_PROD_A,
                    oldPrice: 2000,
                    newPrice: 2200,
                });
                expect(pgBossSendSpy).toHaveBeenCalledTimes(1);

                // Reintento de finalize en la misma conversación devuelve el mismo folio sin encolar otro job
                const retryRes = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/finalize`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: {
                        conversationId: 'conv-emit-1',
                        customerPhone: phone,
                        customerEmail: email,
                        customerName: 'Roberto Emisión',
                        channels: ['email', 'whatsapp'],
                    },
                });
                expect(retryRes.json().ok).toBe(true);
                expect(retryRes.json().folio).toBe(finBody.folio);
                expect(retryRes.json().alreadyEmitted).toBe(true);
                expect(pgBossSendSpy).toHaveBeenCalledTimes(1);

                // Un set-item posterior del mismo contacto crea un carrito NUEVO
                const nextCartRes = await app.inject({
                    method: 'POST',
                    url: `/tools/${tokenA}/quotation/cart/set-item`,
                    headers: { 'x-tool-secret': TOOL_SECRET_A },
                    payload: {
                        conversationId: 'conv-emit-2',
                        customerPhone: phone,
                        sku: SKU_SERV_A,
                        quantity: 1,
                    },
                });
                expect(nextCartRes.json().ok).toBe(true);
                expect(nextCartRes.json().quotationId).not.toBe(firstQuotationId);
            } finally {
                await supabaseAdmin.from('product_variants').update({ price: 2000 }).eq('id', varProdAId);
                await app.close();
            }
        });

        it('15 emisiones concurrentes producen folios consecutivos sin huecos', async () => {
            const { app } = await buildToolsApp();
            try {
                const count = 15;
                const phones = Array.from({ length: count }, (_, i) => `+52558000${String(i + 10).padStart(4, '0')}`);

                for (let i = 0; i < count; i++) {
                    await app.inject({
                        method: 'POST',
                        url: `/tools/${tokenB}/quotation/cart/set-item`,
                        headers: { 'x-tool-secret': TOOL_SECRET_B },
                        payload: {
                            conversationId: `conv-batch-${i}`,
                            customerPhone: phones[i],
                            sku: SKU_PROD_B,
                            quantity: 1,
                        },
                    });
                }

                const responses = await Promise.all(
                    phones.map((phone, i) =>
                        app.inject({
                            method: 'POST',
                            url: `/tools/${tokenB}/quotation/finalize`,
                            headers: { 'x-tool-secret': TOOL_SECRET_B },
                            payload: {
                                conversationId: `conv-batch-${i}`,
                                customerPhone: phone,
                                customerName: `Cliente Lote ${i}`,
                                channels: ['whatsapp'],
                            },
                        })
                    )
                );

                const numbers = responses
                    .map((r) => {
                        const b = r.json();
                        expect(b.ok).toBe(true);
                        return Number(String(b.folio).split('-')[2]);
                    })
                    .sort((a, b) => a - b);

                expect(numbers).toEqual(Array.from({ length: count }, (_, i) => i + 1));
            } finally {
                await app.close();
            }
        });
    });
});
