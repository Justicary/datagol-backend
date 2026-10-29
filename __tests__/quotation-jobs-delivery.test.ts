import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { deleteTestOrganizations } from './helpers/test-data-sweeper.js';
import { setSecret } from '../src/services/secret-service.js';
import { clearEntitlementsCache } from '../src/services/entitlements.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { generateQuotationPdfHandler } from '../src/jobs/generate-quotation-pdf.js';
import { deliverQuotationHandler } from '../src/jobs/deliver-quotation.js';
import { sweepQuotationsHandler } from '../src/jobs/sweep-quotations.js';

describe('Fase F — Jobs de PDF, Entrega (Email/WhatsApp), Metering y Sweep de Cotizaciones', () => {
    let app: FastifyInstance;
    let orgId: string;
    let starterOrgId: string;
    let catalogId: string;
    let productId: string;
    let variantId: string;
    let contactId: string;
    let optedOutContactId: string;

    beforeAll(async () => {
        app = Fastify({ logger: false });
        await app.register(supabasePlugin);
        await app.ready();

        const suffix = crypto.randomUUID().slice(0, 8);

        const { data: org, error: orgErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: `Test Quot Jobs Org ${suffix}`,
                email: `quot-jobs-${suffix}@example.invalid`,
                plan_key: 'pro',
                timezone: 'America/Mexico_City',
                whatsapp_phone_number_id: `1234567890${suffix.slice(0, 4)}`,
            })
            .select('id')
            .single();
        if (orgErr || !org) throw new Error(orgErr?.message ?? 'No se pudo crear org');
        orgId = org.id;

        // Habilitar feature whatsapp para pruebas de entrega por WhatsApp
        await supabaseAdmin.from('organization_features').upsert({
            organization_id: orgId,
            feature_key: 'whatsapp',
            enabled: true,
            reason: 'Prueba Fase F',
        });
        clearEntitlementsCache(orgId);

        await setSecret(orgId, SECRET_KEYS.WHATSAPP_ACCESS_TOKEN, 'test-wa-token-fase-f');

        const { data: sOrg, error: sOrgErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: `Test Quot Jobs Starter ${suffix}`,
                email: `quot-jobs-starter-${suffix}@example.invalid`,
                plan_key: 'starter',
                timezone: 'America/Mexico_City',
            })
            .select('id')
            .single();
        if (sOrgErr || !sOrg) throw new Error(sOrgErr?.message ?? 'No se pudo crear starterOrg');
        starterOrgId = sOrg.id;

        const { data: cat, error: catErr } = await supabaseAdmin
            .from('catalogs')
            .insert({
                owner_organization_id: orgId,
                name: `Catálogo Jobs ${suffix}`,
            })
            .select('id')
            .single();
        if (catErr || !cat) throw new Error(catErr?.message ?? 'No se pudo crear catálogo');
        catalogId = cat.id;

        const { data: prod, error: prodErr } = await supabaseAdmin
            .from('products')
            .insert({
                catalog_id: catalogId,
                name: 'Bomba Hidráulica Industrial',
                category: 'Equipos',
                item_type: 'producto',
            })
            .select('id')
            .single();
        if (prodErr || !prod) throw new Error(prodErr?.message ?? 'No se pudo crear producto');
        productId = prod.id;

        const { data: variant, error: varErr } = await supabaseAdmin
            .from('product_variants')
            .insert({
                product_id: productId,
                catalog_id: catalogId,
                sku: `BOMBA-F-${suffix}`.toUpperCase(),
                presentation: '5 HP Trifásica',
                price: 11600,
                currency: 'MXN',
                price_includes_tax: true,
                tax_rate: 0.16,
                stock_status: 'disponible',
                billing_period: 'unico',
            })
            .select('id')
            .single();
        if (varErr || !variant) throw new Error(varErr?.message ?? 'No se pudo crear variante');
        variantId = variant.id;

        const { data: contact, error: cErr } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: orgId,
                full_name: 'Laura Méndez',
                phone_e164: '+525544332211',
                email: `laura.${suffix}@cliente.mx`,
                opted_out: false,
            })
            .select('id')
            .single();
        if (cErr || !contact) throw new Error(cErr?.message ?? 'No se pudo crear contacto');
        contactId = contact.id;

        const { data: optedContact, error: ocErr } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: orgId,
                full_name: 'Contacto OptOut',
                phone_e164: '+525599887766',
                email: `optout.${suffix}@cliente.mx`,
                opted_out: true,
            })
            .select('id')
            .single();
        if (ocErr || !optedContact) throw new Error(ocErr?.message ?? 'No se pudo crear optedOutContact');
        optedOutContactId = optedContact.id;
    }, 30000);

    afterAll(async () => {
        await app?.close();
        if (orgId) {
            await supabaseAdmin.from('whatsapp_messages').delete().eq('organization_id', orgId);
            await supabaseAdmin.from('usage_events').delete().eq('organization_id', orgId);
        }
        await deleteTestOrganizations(supabaseAdmin, [orgId, starterOrgId]);
    });

    async function createEmittedQuotation(params: {
        folio: string;
        folioNumber: number;
        contactIdToUse?: string;
        phone?: string | null;
        email?: string | null;
        validUntil?: string;
    }): Promise<string> {
        const { data: quot, error: qErr } = await supabaseAdmin
            .from('quotations')
            .insert({
                organization_id: orgId,
                status: 'borrador',
                origin: 'dashboard',
                contact_id: params.contactIdToUse ?? contactId,
                customer_name: 'Laura Méndez',
                customer_email: params.email !== undefined ? params.email : 'laura@cliente.mx',
                customer_phone_e164: params.phone !== undefined ? params.phone : '+525544332211',
                currency: 'MXN',
                subtotal: 10000,
                tax_total: 1600,
                discount_total: 0,
                total: 11600,
                totals_by_billing: [{ billingPeriod: 'unico', subtotal: 10000, tax: 1600, discount: 0, total: 11600 }],
                tax_breakdown: [{ taxRate: 0.16, base: 10000, tax: 1600 }],
            })
            .select('id')
            .single();
        if (qErr || !quot) throw new Error(qErr?.message ?? 'Error creando borrador');

        await supabaseAdmin.from('quotation_items').insert({
            quotation_id: quot.id,
            organization_id: orgId,
            line_number: 1,
            variant_id: variantId,
            product_id: productId,
            catalog_id: catalogId,
            sku: 'BOMBA-TEST',
            item_type: 'producto',
            billing_period: 'unico',
            product_name: 'Bomba Hidráulica Industrial',
            presentation: '5 HP Trifásica',
            quantity: 1,
            unit_price: 11600,
            price_includes_tax: true,
            tax_rate: 0.16,
            discount_amount: 0,
            line_subtotal: 10000,
            line_tax: 1600,
            line_total: 11600,
        });

        const { error: updErr } = await supabaseAdmin
            .from('quotations')
            .update({
                status: 'emitida',
                folio: params.folio,
                folio_year: 2026,
                folio_number: params.folioNumber,
                issued_at: new Date().toISOString(),
                valid_until: params.validUntil ?? '2026-12-31',
            })
            .eq('id', quot.id);
        if (updErr) throw new Error(updErr.message);

        return quot.id;
    }

    it('generateQuotationPdfHandler genera PDF, lo sube a Storage, registra evento pdf_generado y es idempotente al re-ejecutar', async () => {
        const quotationId = await createEmittedQuotation({
            folio: 'COT-2026-000101',
            folioNumber: 101,
        });

        const res1 = await generateQuotationPdfHandler(app, {
            organizationId: orgId,
            quotationId,
            requestedChannels: ['whatsapp'],
        });

        expect(res1.generated).toBe(true);
        expect(res1.alreadyExisted).toBe(false);
        expect(res1.storagePath).toBe(`${orgId}/2026/COT-2026-000101.pdf`);
        expect(res1.pdfSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(res1.enqueuedDeliveryIds.length).toBe(1);

        // Re-ejecución idempotente: no regenera el PDF ni duplica la fila en quotation_deliveries
        const res2 = await generateQuotationPdfHandler(app, {
            organizationId: orgId,
            quotationId,
            requestedChannels: ['whatsapp'],
        });
        expect(res2.generated).toBe(false);
        expect(res2.alreadyExisted).toBe(true);
        expect(res2.pdfSha256).toBe(res1.pdfSha256);

        const { data: deliveries } = await supabaseAdmin
            .from('quotation_deliveries')
            .select('id')
            .eq('quotation_id', quotationId);
        expect(deliveries?.length).toBe(1);

        // Contraparte: organización starter sin feature `quotations` omite generación
        const resStarter = await generateQuotationPdfHandler(app, {
            organizationId: starterOrgId,
            quotationId,
        });
        expect(resStarter.generated).toBe(false);
        expect(resStarter.skipReason).toBe('feature_disabled');
    });

    it('deliverQuotationHandler omite WhatsApp cuando está fuera de ventana de 24h sin plantilla, cuando el contacto es opted_out o teléfono inválido', async () => {
        const quotationId = await createEmittedQuotation({
            folio: 'COT-2026-000102',
            folioNumber: 102,
        });
        await generateQuotationPdfHandler(app, {
            organizationId: orgId,
            quotationId,
            requestedChannels: ['whatsapp'],
        });

        const { data: delRow } = await supabaseAdmin
            .from('quotation_deliveries')
            .select('id')
            .eq('quotation_id', quotationId)
            .single();

        // Sin mensaje inbound en las últimas 24h y sin whatsapp_template_name -> omitido
        const outOfWindowRes = await deliverQuotationHandler(app, {
            organizationId: orgId,
            deliveryId: delRow!.id,
        });
        expect(outOfWindowRes.status).toBe('omitido');
        expect(outOfWindowRes.skipReason).toBe('fuera_de_ventana_sin_plantilla');

        // Contraparte: contacto con opted_out = true -> omitido ('contacto_opted_out')
        const optOutQuotId = await createEmittedQuotation({
            folio: 'COT-2026-000103',
            folioNumber: 103,
            contactIdToUse: optedOutContactId,
            phone: '+525599887766',
        });
        const optOutGen = await generateQuotationPdfHandler(app, {
            organizationId: orgId,
            quotationId: optOutQuotId,
            requestedChannels: ['whatsapp'],
        });
        const optOutDel = await deliverQuotationHandler(app, {
            organizationId: orgId,
            deliveryId: optOutGen.enqueuedDeliveryIds[0],
        });
        expect(optOutDel.status).toBe('omitido');
        expect(optOutDel.skipReason).toBe('contacto_opted_out');

        // Teléfono inválido en quotation_deliveries -> omitido ('telefono_e164_invalido')
        const { data: badPhoneDel } = await supabaseAdmin
            .from('quotation_deliveries')
            .insert({
                organization_id: orgId,
                quotation_id: quotationId,
                channel: 'whatsapp',
                recipient: 'no-es-un-telefono',
                status: 'pendiente',
                idempotency_key: `bad-phone:${quotationId}`,
            })
            .select('id')
            .single();

        const badPhoneRes = await deliverQuotationHandler(app, {
            organizationId: orgId,
            deliveryId: badPhoneDel!.id,
        });
        expect(badPhoneRes.status).toBe('omitido');
        expect(badPhoneRes.skipReason).toBe('telefono_e164_invalido');
    });

    it('deliverQuotationHandler envía WhatsApp con plantilla fuera de ventana o como documento dentro de ventana, promueve a enviada, registra usage_events y es idempotente en reintento', async () => {
        // Configurar whatsapp_template_name en quotation_settings
        await supabaseAdmin.from('quotation_settings').upsert({
            organization_id: orgId,
            whatsapp_template_name: 'cotizacion_pdf_v1',
        });

        const quotationId = await createEmittedQuotation({
            folio: 'COT-2026-000104',
            folioNumber: 104,
        });
        const genRes = await generateQuotationPdfHandler(app, {
            organizationId: orgId,
            quotationId,
            requestedChannels: ['whatsapp'],
        });
        const deliveryId = genRes.enqueuedDeliveryIds[0];

        const originalFetch = global.fetch;
        const sentPayloads: Record<string, unknown>[] = [];
        global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (url.includes('graph.facebook.com')) {
                if (init?.body) {
                    sentPayloads.push(JSON.parse(String(init.body)));
                }
                return new Response(
                    JSON.stringify({ messages: [{ id: `wamid.quot.${quotationId}` }] }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                );
            }
            return originalFetch(input, init);
        });

        try {
            // 1. Fuera de ventana pero CON plantilla configurada -> envía template con document header
            const delRes1 = await deliverQuotationHandler(app, {
                organizationId: orgId,
                deliveryId,
            });
            expect(delRes1.status).toBe('enviado');
            expect(delRes1.providerMessageId).toBe(`wamid.quot.${quotationId}`);
            expect(sentPayloads.length).toBe(1);
            expect(sentPayloads[0].type).toBe('template');

            // Verificar que la cotización pasó de `emitida` a `enviada`
            const { data: updatedQuot } = await supabaseAdmin
                .from('quotations')
                .select('status')
                .eq('id', quotationId)
                .single();
            expect(updatedQuot?.status).toBe('enviada');

            // Verificar metering en usage_events (1 asiento con idempotency_key única)
            const { data: usageRows } = await supabaseAdmin
                .from('usage_events')
                .select('*')
                .eq('organization_id', orgId)
                .eq('idempotency_key', `wa-quotation:wamid.quot.${quotationId}`);
            expect(usageRows?.length).toBe(1);
            expect(Number(usageRows![0].unit_rate_usd)).toBeGreaterThan(0);

            // 2. Reintento del mismo deliveryId -> idempotente (`already_sent`), no vuelve a llamar a Meta ni duplica usage_events
            const delResRetry = await deliverQuotationHandler(app, {
                organizationId: orgId,
                deliveryId,
            });
            expect(delResRetry.status).toBe('already_sent');
            expect(sentPayloads.length).toBe(1);

            // 3. Ahora simular mensaje inbound del contacto para abrir ventana de 24h y probar envío `type: 'document'`
            const { error: waInErr } = await supabaseAdmin.from('whatsapp_messages').insert({
                organization_id: orgId,
                contact_id: contactId,
                direction: 'inbound',
                body: 'Hola, envíame la cotización por favor',
                wa_message_id: `wamid.inbound.${quotationId}`,
            });
            if (waInErr) throw new Error(waInErr.message);

            const { data: docDel } = await supabaseAdmin
                .from('quotation_deliveries')
                .insert({
                    organization_id: orgId,
                    quotation_id: quotationId,
                    channel: 'whatsapp',
                    recipient: '+525544332211',
                    status: 'pendiente',
                    idempotency_key: `resend-doc:${quotationId}`,
                })
                .select('id')
                .single();

            const docRes = await deliverQuotationHandler(app, {
                organizationId: orgId,
                deliveryId: docDel!.id,
            });
            expect(docRes.status).toBe('enviado');
            expect(sentPayloads.length).toBe(2);
            expect(sentPayloads[1].type).toBe('document');
            const docObj = sentPayloads[1].document as { filename: string; caption: string };
            expect(docObj.filename).toBe('COT-2026-000104.pdf');
            expect(docObj.caption).toContain('COT-2026-000104');
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('sweepQuotationsHandler marca borradores inactivos > cart_ttl_hours como abandonada y emitidas con valid_until pasado como vencida', async () => {
        // 1. Crear cotización emitida con valid_until vencido ('2025-01-01') y otra vigente ('2027-12-31')
        const expiredQuotId = await createEmittedQuotation({
            folio: 'COT-2026-000105',
            folioNumber: 105,
            validUntil: '2025-01-01',
        });
        const validQuotId = await createEmittedQuotation({
            folio: 'COT-2026-000106',
            folioNumber: 106,
            validUntil: '2027-12-31',
        });

        // 2. Crear borrador antiguo (hace 200 horas, default TTL = 168h)
        const oldActivityIso = new Date(Date.now() - 200 * 3600 * 1000).toISOString();
        const { data: oldDraft, error: oldDraftErr } = await supabaseAdmin
            .from('quotations')
            .insert({
                organization_id: orgId,
                status: 'borrador',
                origin: 'agente',
                contact_id: contactId,
                last_activity_at: oldActivityIso,
            })
            .select('id')
            .single();
        if (oldDraftErr || !oldDraft) throw new Error(oldDraftErr?.message ?? 'Error creando oldDraft');

        const sweepRes = await sweepQuotationsHandler(app, {
            organizationId: orgId,
            now: new Date('2026-10-26T18:00:00.000Z'),
        });

        expect(sweepRes.abandonedCount).toBeGreaterThanOrEqual(1);
        expect(sweepRes.expiredCount).toBeGreaterThanOrEqual(1);

        const { data: checkDraft } = await supabaseAdmin
            .from('quotations')
            .select('status')
            .eq('id', oldDraft!.id)
            .single();
        expect(checkDraft?.status).toBe('abandonada');

        const { data: checkExpired } = await supabaseAdmin
            .from('quotations')
            .select('status')
            .eq('id', expiredQuotId)
            .single();
        expect(checkExpired?.status).toBe('vencida');

        const { data: checkValid } = await supabaseAdmin
            .from('quotations')
            .select('status')
            .eq('id', validQuotId)
            .single();
        expect(checkValid?.status).toBe('emitida');
    });
});
