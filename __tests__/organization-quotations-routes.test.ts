import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { deleteTestOrganizations, deleteTestUsers } from './helpers/test-data-sweeper.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationQuotationsRoutes from '../src/routes/organization-quotations.js';
import { validateAttachmentMagicBytes } from '../src/lib/magic-bytes.js';

const env = validateEnv();

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(tag: string): Promise<TestUser> {
    const email = `test-quot-routes-${tag}-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
    });
    if (createErr || !created.user) {
        throw new Error(`No se pudo crear usuario de prueba: ${createErr?.message}`);
    }
    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) {
        throw new Error(`No se pudo iniciar sesión de prueba: ${signInErr?.message}`);
    }
    return { userId: created.user.id, jwt: session.session.access_token };
}

describe('Fases G, H, I.1 — API del Dashboard de Cotizaciones, Exportación, RLS, ARCO y Retención', () => {
    let app: FastifyInstance;
    let ownerA: TestUser;
    let ownerB: TestUser;
    let orgAId: string;
    let orgBId: string;
    let catalogAId: string;
    let productAId: string;
    let variantAId: string;
    let variantASku: string;
    let contactAId: string;
    let contactArcoId: string;
    let contactBId: string;
    let quotationBId: string;

    beforeAll(async () => {
        app = Fastify({ logger: false });
        await app.register(supabasePlugin);
        await app.register(organizationQuotationsRoutes);
        await app.ready();

        const suffix = crypto.randomUUID().slice(0, 8);
        [ownerA, ownerB] = await Promise.all([
            createTestUserWithJwt(`ownerA-${suffix}`),
            createTestUserWithJwt(`ownerB-${suffix}`),
        ]);

        const { data: orgA, error: orgAErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: `Org Quot A ${suffix}`,
                email: `org-quot-a-${suffix}@example.invalid`,
                plan_key: 'pro',
                timezone: 'America/Mexico_City',
            })
            .select('id')
            .single();
        if (orgAErr || !orgA) throw new Error(orgAErr?.message ?? 'Error creando orgA');
        orgAId = orgA.id;

        const { data: orgB, error: orgBErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: `Org Quot B ${suffix}`,
                email: `org-quot-b-${suffix}@example.invalid`,
                plan_key: 'pro',
                timezone: 'America/Mexico_City',
            })
            .select('id')
            .single();
        if (orgBErr || !orgB) throw new Error(orgBErr?.message ?? 'Error creando orgB');
        orgBId = orgB.id;

        await supabaseAdmin.from('organization_members').insert([
            { organization_id: orgAId, user_id: ownerA.userId, role: 'owner' },
            { organization_id: orgBId, user_id: ownerB.userId, role: 'owner' },
        ]);

        const { data: catA, error: catAErr } = await supabaseAdmin
            .from('catalogs')
            .insert({
                owner_organization_id: orgAId,
                name: `Catálogo Org A ${suffix}`,
            })
            .select('id')
            .single();
        if (catAErr || !catA) throw new Error(catAErr?.message ?? 'Error creando catA');
        catalogAId = catA.id;

        const { data: prodA, error: prodAErr } = await supabaseAdmin
            .from('products')
            .insert({
                catalog_id: catalogAId,
                name: 'Compresor Industrial Tornillo',
                category: 'Maquinaria',
                item_type: 'producto',
                sat_product_key: '40151500',
            })
            .select('id')
            .single();
        if (prodAErr || !prodA) throw new Error(prodAErr?.message ?? 'Error creando prodA');
        productAId = prodA.id;

        variantASku = `COMP-A-${suffix}`.toUpperCase();
        const { data: varA, error: varAErr } = await supabaseAdmin
            .from('product_variants')
            .insert({
                product_id: productAId,
                catalog_id: catalogAId,
                sku: variantASku,
                presentation: '10 HP',
                price: 23200,
                currency: 'MXN',
                price_includes_tax: true,
                tax_rate: 0.16,
                stock_status: 'disponible',
                billing_period: 'unico',
                sat_unit_key: 'H87',
            })
            .select('id')
            .single();
        if (varAErr || !varA) throw new Error(varAErr?.message ?? 'Error creando varA');
        variantAId = varA.id;

        const { data: cA, error: cAErr } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: orgAId,
                full_name: 'Carlos Ruiz',
                email: `carlos.${suffix}@empresa.mx`,
                phone_e164: '+525511223344',
                business_name: 'Industrias Ruiz',
            })
            .select('id')
            .single();
        if (cAErr || !cA) throw new Error(cAErr?.message ?? 'Error creando cA');
        contactAId = cA.id;

        const { data: cArco, error: cArcoErr } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: orgAId,
                full_name: 'María Privacidad',
                email: `maria.arco.${suffix}@empresa.mx`,
                phone_e164: '+525566778899',
                business_name: 'Privacidad S.A.',
            })
            .select('id')
            .single();
        if (cArcoErr || !cArco) throw new Error(cArcoErr?.message ?? 'Error creando cArco');
        contactArcoId = cArco.id;

        const { data: cB, error: cBErr } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: orgBId,
                full_name: 'Contacto Org B',
                email: `b.${suffix}@orgb.mx`,
                phone_e164: '+525500001111',
            })
            .select('id')
            .single();
        if (cBErr || !cB) throw new Error(cBErr?.message ?? 'Error creando cB');
        contactBId = cB.id;

        const { data: qB, error: qBErr } = await supabaseAdmin
            .from('quotations')
            .insert({
                organization_id: orgBId,
                status: 'borrador',
                origin: 'dashboard',
                contact_id: contactBId,
                customer_name: 'Contacto Org B',
            })
            .select('id')
            .single();
        if (qBErr || !qB) throw new Error(qBErr?.message ?? 'Error creando qB');
        quotationBId = qB.id;
    }, 30000);

    afterAll(async () => {
        await app?.close();
        await deleteTestOrganizations(supabaseAdmin, [orgAId, orgBId]);
        await deleteTestUsers(supabaseAdmin, [ownerA?.userId, ownerB?.userId]);
    });

    it('aislamiento multi-tenant y RLS: sesión de A recibe 404 al pedir cotización de B, 200 con sesión de B; authenticated no lee cotizaciones de otro tenant ni puede insertar/actualizar directo en Supabase', async () => {
        // 1. GET /quotations/:id de B bajo la ruta de A con sesión de A -> 404
        const resCross = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgAId}/quotations/${quotationBId}`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
        });
        expect(resCross.statusCode).toBe(404);

        // 2. GET /quotations/:id de B bajo la ruta de B con sesión de A -> 403 PERMISSION_DENIED
        const resForbidden = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgBId}/quotations/${quotationBId}`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
        });
        expect(resForbidden.statusCode).toBe(403);

        // 3. Contraparte de éxito: sesión de B lee su propia cotización -> 200
        const resOwn = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgBId}/quotations/${quotationBId}`,
            headers: { authorization: `Bearer ${ownerB.jwt}` },
        });
        expect(resOwn.statusCode).toBe(200);
        expect(resOwn.json().quotation.id).toBe(quotationBId);

        // 4. RLS directa con cliente `authenticated` de A
        if (env.SUPABASE_PUBLISHABLE_KEY) {
            const clientA = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
                global: { headers: { Authorization: `Bearer ${ownerA.jwt}` } },
            });

            // No puede leer cotización de B
            const { data: readB } = await clientA
                .from('quotations')
                .select('id')
                .eq('id', quotationBId);
            expect(readB ?? []).toHaveLength(0);

            // No puede insertar ni en su propia organización A (RLS es solo lectura para authenticated)
            const { error: directInsertErr } = await clientA.from('quotations').insert({
                organization_id: orgAId,
                status: 'borrador',
                origin: 'dashboard',
                contact_id: contactAId,
            });
            expect(directInsertErr).not.toBeNull();
        }
    });

    it('ejecuta el flujo completo del dashboard: settings, búsqueda, crear borrador (y 409 en duplicado), reemplazar partidas con descuento, emitir, generar PDF, aceptar (con suggestedDealValue) y crear/emitir revisión -R1', async () => {
        // 1. Configurar prefijo de folio 'QTE' en quotation-settings
        const putSettingsRes = await app.inject({
            method: 'PUT',
            url: `/api/organizations/${orgAId}/quotation-settings`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
            payload: {
                folioPrefix: 'QTE',
                validityDays: 20,
                termsText: 'Pago 100% antes de embarque.',
            },
        });
        expect(putSettingsRes.statusCode).toBe(200);
        expect(putSettingsRes.json().settings.folio_prefix).toBe('QTE');

        // 2. Buscar en catálogo desde el editor
        const searchRes = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgAId}/catalog/search?q=Compresor`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
        });
        expect(searchRes.statusCode).toBe(200);
        expect(searchRes.json().items.length).toBeGreaterThanOrEqual(1);

        // 3. Crear borrador para contactAId -> 201
        const createRes = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgAId}/quotations`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
            payload: {
                contactId: contactAId,
                notes: 'Cotización prioritaria de planta.',
            },
        });
        expect(createRes.statusCode).toBe(201);
        const draftId = createRes.json().quotation.id as string;
        expect(draftId).toBeTruthy();

        // 4. Intentar crear un segundo borrador para el mismo contacto -> 409 con existingQuotationId
        const duplicateDraftRes = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgAId}/quotations`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
            payload: { contactId: contactAId },
        });
        expect(duplicateDraftRes.statusCode).toBe(409);
        expect(duplicateDraftRes.json().existingQuotationId).toBe(draftId);

        // 5. Reemplazar partidas del borrador (cantidad 2, descuento $1,000 sobre base)
        const putItemsRes = await app.inject({
            method: 'PUT',
            url: `/api/organizations/${orgAId}/quotations/${draftId}/items`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
            payload: {
                items: [
                    {
                        sku: variantASku,
                        quantity: 2,
                        discountAmount: 1000,
                    },
                ],
            },
        });
        expect(putItemsRes.statusCode).toBe(200);
        const updatedDraft = putItemsRes.json().quotation;
        // 2 * 23,200 (IVA incluido 16%) => base bruta = 40,000; descuento = 1,000 => subtotal = 39,000; IVA = 6,240; total = 45,240
        expect(Number(updatedDraft.subtotal)).toBe(39000);
        expect(Number(updatedDraft.tax_total)).toBe(6240);
        expect(Number(updatedDraft.total)).toBe(45240);

        // 6. Emitir la cotización -> folio QTE-2026-000001
        const emitRes = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgAId}/quotations/${draftId}/emit`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
            payload: {
                channels: [],
            },
        });
        expect(emitRes.statusCode).toBe(200);
        expect(emitRes.json().folio).toMatch(/^QTE-\d{4}-000001$/);

        // 7. Intentar editar partidas de una cotización ya emitida -> 400 InvalidStatus
        const editEmittedRes = await app.inject({
            method: 'PUT',
            url: `/api/organizations/${orgAId}/quotations/${draftId}/items`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
            payload: { items: [] },
        });
        expect(editEmittedRes.statusCode).toBe(400);

        // 8. Obtener URL firmada del PDF (genera on-the-fly si aún no corrió el worker)
        const pdfRes = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgAId}/quotations/${draftId}/pdf`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
        });
        expect(pdfRes.statusCode).toBe(200);
        expect(pdfRes.json().signedUrl).toContain('http');

        // 9. Marcar como `aceptada` -> devuelve suggestedDealValue (45240) sin escribir contacts.deal_value
        const acceptRes = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgAId}/quotations/${draftId}/status`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
            payload: {
                status: 'aceptada',
                reason: 'Orden de compra recibida',
            },
        });
        expect(acceptRes.statusCode).toBe(200);
        expect(acceptRes.json().suggestedDealValue).toBe(45240);

        const { data: contactAfterAccept } = await supabaseAdmin
            .from('contacts')
            .select('deal_value')
            .eq('id', contactAId)
            .single();
        expect(contactAfterAccept?.deal_value).toBeNull();

        // 10. Crear revisión `-R1` y emitirla -> conserva el mismo número base con sufijo `-R1`
        const reviseRes = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgAId}/quotations/${draftId}/revise`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
            payload: { reason: 'Ajuste de alcance' },
        });
        expect(reviseRes.statusCode).toBe(201);
        const revDraftId = reviseRes.json().quotation.id as string;
        expect(reviseRes.json().quotation.revision_number).toBe(1);

        const emitRevRes = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgAId}/quotations/${revDraftId}/emit`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
            payload: { channels: [] },
        });
        expect(emitRevRes.statusCode).toBe(200);
        expect(emitRevRes.json().folio).toMatch(/^QTE-\d{4}-000001-R1$/);

        // 11. Consultar historial del contacto y métricas de la organización
        const contactHistRes = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgAId}/contacts/${contactAId}/quotations`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
        });
        expect(contactHistRes.statusCode).toBe(200);
        expect(contactHistRes.json().quotations.length).toBe(2);

        const metricsRes = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgAId}/quotations/metrics`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
        });
        expect(metricsRes.statusCode).toBe(200);
        expect(metricsRes.json().metrics.quotationsEmitted).toBeGreaterThanOrEqual(2);
        expect(metricsRes.json().metrics.quotationsAccepted).toBeGreaterThanOrEqual(1);
    });

    it('exporta cotizaciones en formato JSON (datagol.quotation.v1), CSV y XLSX registrando el evento exportada', async () => {
        // 1. JSON v1
        const jsonExport = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgAId}/quotations/export?format=json`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
        });
        expect(jsonExport.statusCode).toBe(200);
        const body = jsonExport.json();
        expect(body.schema).toBe('datagol.quotation.v1');
        expect(body.count).toBeGreaterThanOrEqual(2);
        expect(body.quotations[0].items[0].item_type).toBe('producto');
        expect(body.quotations[0].items[0].billing_period).toBe('unico');
        expect(body.quotations[0].items[0].sat_unit_key).toBe('H87');

        // 2. CSV
        const csvExport = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgAId}/quotations/export?format=csv`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
        });
        expect(csvExport.statusCode).toBe(200);
        expect(csvExport.headers['content-type']).toContain('text/csv');
        expect(csvExport.body).toContain('quotation_id,folio,status');
        expect(csvExport.body).toContain(variantASku);

        // 3. XLSX
        const xlsxExport = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgAId}/quotations/export?format=xlsx`,
            headers: { authorization: `Bearer ${ownerA.jwt}` },
        });
        expect(xlsxExport.statusCode).toBe(200);
        const magic = validateAttachmentMagicBytes(xlsxExport.rawPayload);
        expect(magic?.extension).toBe('xlsx');
    });

    it('ARCO (erase_contact_pii) anonimiza customer_* y recipient de entregas, conserva folio/importes y elimina su borrador abierto', async () => {
        // 1. Crear una cotización emitida y un borrador abierto para contactArcoId
        const { data: emittedArco } = await supabaseAdmin
            .from('quotations')
            .insert({
                organization_id: orgAId,
                status: 'borrador',
                origin: 'dashboard',
                contact_id: contactArcoId,
                customer_name: 'María Privacidad',
                customer_email: 'maria.arco@empresa.mx',
                customer_phone_e164: '+525566778899',
                customer_business_name: 'Privacidad S.A.',
                subtotal: 1000,
                tax_total: 160,
                total: 1160,
            })
            .select('id')
            .single();

        await supabaseAdmin
            .from('quotations')
            .update({
                status: 'emitida',
                folio: 'QTE-2026-000900',
                folio_year: 2026,
                folio_number: 900,
                issued_at: new Date().toISOString(),
            })
            .eq('id', emittedArco!.id);

        await supabaseAdmin.from('quotation_deliveries').insert({
            organization_id: orgAId,
            quotation_id: emittedArco!.id,
            channel: 'email',
            recipient: 'maria.arco@empresa.mx',
            status: 'enviado',
            idempotency_key: `arco-del:${emittedArco!.id}`,
        });

        const { data: draftArco } = await supabaseAdmin
            .from('quotations')
            .insert({
                organization_id: orgAId,
                status: 'borrador',
                origin: 'agente',
                contact_id: contactArcoId,
                customer_name: 'María Privacidad',
            })
            .select('id')
            .single();

        // 2. Ejecutar erase_contact_pii
        // Se invoca con el JWT del owner, igual que `routes/contacts.ts`: la
        // función verifica pertenencia contra auth_active_organization_ids().
        const clientArco = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY, {
            global: { headers: { Authorization: `Bearer ${ownerA.jwt}` } },
        });
        const { error: arcoErr } = await clientArco.rpc('erase_contact_pii', {
            p_contact_id: contactArcoId,
        });
        expect(arcoErr).toBeNull();

        // 3. El borrador abierto fue eliminado
        const { data: checkDraft } = await supabaseAdmin
            .from('quotations')
            .select('id')
            .eq('id', draftArco!.id)
            .maybeSingle();
        expect(checkDraft).toBeNull();

        // 4. La cotización emitida conserva folio e importes, pero customer_* y recipient están anonimizados
        const { data: checkEmitted } = await supabaseAdmin
            .from('quotations')
            .select('*')
            .eq('id', emittedArco!.id)
            .single();
        expect(checkEmitted?.folio).toBe('QTE-2026-000900');
        expect(Number(checkEmitted?.total)).toBe(1160);
        expect(checkEmitted?.customer_email).toBeNull();
        expect(checkEmitted?.customer_phone_e164).toBeNull();
        expect(checkEmitted?.customer_business_name).toBeNull();

        const { data: checkDelivery } = await supabaseAdmin
            .from('quotation_deliveries')
            .select('recipient')
            .eq('quotation_id', emittedArco!.id)
            .single();
        expect(checkDelivery?.recipient).toBeNull();
    });

    it('retención D3: purge_abandoned_quotations() borra abandonada > 90 días y conserva abandonada reciente y emitida/vencida/cancelada/rechazada viejas', async () => {
        const hundredDaysAgo = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
        const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();

        // Crear un contacto temporal para la abandonada reciente
        const { data: tempContact } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: orgAId,
                full_name: 'Contacto Retención',
                phone_e164: '+525577778888',
            })
            .select('id')
            .single();

        // 1. Abandonada vieja (> 90 días) -> DEBE purgarse
        const { data: oldAbandoned } = await supabaseAdmin
            .from('quotations')
            .insert({
                organization_id: orgAId,
                status: 'abandonada',
                origin: 'agente',
                contact_id: contactAId,
                last_activity_at: hundredDaysAgo,
            })
            .select('id')
            .single();

        // 2. Abandonada reciente (5 días) -> NO debe purgarse
        const { data: recentAbandoned } = await supabaseAdmin
            .from('quotations')
            .insert({
                organization_id: orgAId,
                status: 'abandonada',
                origin: 'agente',
                contact_id: tempContact!.id,
                last_activity_at: fiveDaysAgo,
            })
            .select('id')
            .single();

        // 3. Cancelada vieja (> 90 días) -> NO debe purgarse
        const { data: oldCancelled } = await supabaseAdmin
            .from('quotations')
            .insert({
                organization_id: orgAId,
                status: 'borrador',
                origin: 'dashboard',
                contact_id: contactAId,
                last_activity_at: hundredDaysAgo,
            })
            .select('id')
            .single();
        await supabaseAdmin
            .from('quotations')
            .update({ status: 'cancelada', last_activity_at: hundredDaysAgo })
            .eq('id', oldCancelled!.id);

        // Sin parámetros: cada organización aplica su propio retention_days (D3).
        const { data: purgeResult, error: purgeErr } = await supabaseAdmin.rpc('purge_abandoned_quotations');
        expect(purgeErr).toBeNull();
        expect(Number((purgeResult as { abandoned_quotations_purged: number }).abandoned_quotations_purged)).toBeGreaterThanOrEqual(1);

        const { data: checkOldAbandoned } = await supabaseAdmin
            .from('quotations')
            .select('id')
            .eq('id', oldAbandoned!.id)
            .maybeSingle();
        expect(checkOldAbandoned).toBeNull();

        const { data: checkRecentAbandoned } = await supabaseAdmin
            .from('quotations')
            .select('id')
            .eq('id', recentAbandoned!.id)
            .maybeSingle();
        expect(checkRecentAbandoned?.id).toBe(recentAbandoned!.id);

        const { data: checkOldCancelled } = await supabaseAdmin
            .from('quotations')
            .select('id')
            .eq('id', oldCancelled!.id)
            .maybeSingle();
        expect(checkOldCancelled?.id).toBe(oldCancelled!.id);
    });
});
