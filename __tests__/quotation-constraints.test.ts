import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import {
    ALL_CATALOG_ITEM_TYPES,
    CATALOG_ITEM_TYPES,
    isCatalogItemType,
} from '../src/types/catalog-item-type.js';
import {
    ALL_BILLING_PERIODS,
    BILLING_PERIODS,
    isBillingPeriod,
} from '../src/types/billing-period.js';
import {
    ALL_QUOTATION_STATUSES,
    QUOTATION_STATUSES,
    isQuotationStatus,
} from '../src/types/quotation-status.js';
import {
    ALL_QUOTATION_ORIGINS,
    isQuotationOrigin,
} from '../src/types/quotation-origin.js';
import {
    ALL_QUOTATION_DELIVERY_CHANNELS,
    isQuotationDeliveryChannel,
    ALL_QUOTATION_DELIVERY_STATUSES,
    isQuotationDeliveryStatus,
    ALL_QUOTATION_EMAIL_SENDERS,
    isQuotationEmailSender,
    ALL_QUOTATION_CHANNELS,
    isQuotationChannel,
} from '../src/types/quotation-delivery.js';
import {
    ALL_QUOTATION_EVENT_TYPES,
    isQuotationEventType,
} from '../src/types/quotation-event-type.js';
import { FEATURE_KEYS } from '../src/types/feature-taxonomy.js';
import { PERMISSION_KEYS } from '../src/types/permission-keys.js';

describe('Fase A y B2 — Módulos de constraint sincronizados con la base real', () => {
    let orgId: string;
    let groupId: string;
    let catalogId: string;
    let productId: string;
    let contactId: string;
    let customerId: string;

    beforeAll(async () => {
        const { data: group, error: gErr } = await supabaseAdmin
            .from('credential_groups')
            .insert({ name: `Grupo Constraints Cotizaciones` })
            .select('id')
            .single();
        if (gErr || !group) throw new Error(gErr?.message);
        groupId = group.id;

        const { data: org, error: oErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org Constraints Cotizaciones',
                email: `org-quote-constraints-${crypto.randomUUID()}@example.invalid`,
                credential_group_id: groupId,
                plan_key: 'pro',
            })
            .select('id')
            .single();
        if (oErr || !org) throw new Error(oErr?.message);
        orgId = org.id;

        const { data: catalog, error: cErr } = await supabaseAdmin
            .from('catalogs')
            .insert({ owner_organization_id: orgId, name: 'Catálogo Constraints' })
            .select('id')
            .single();
        if (cErr || !catalog) throw new Error(cErr?.message);
        catalogId = catalog.id;

        const { data: product, error: pErr } = await supabaseAdmin
            .from('products')
            .insert({ catalog_id: catalogId, name: 'Producto Base' })
            .select('id')
            .single();
        if (pErr || !product) throw new Error(pErr?.message);
        productId = product.id;

        const { data: contact, error: ctErr } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: orgId,
                full_name: 'Contacto Constraints',
                phone_e164: '+525599887766',
            })
            .select('id')
            .single();
        if (ctErr || !contact) throw new Error(ctErr?.message);
        contactId = contact.id;

        const { data: customer, error: custErr } = await supabaseAdmin
            .from('customers')
            .insert({
                legal_name: 'Cliente Constraints S.A. de C.V.',
                contact_name: 'Contacto Comercial',
                contact_email: `cliente-constraints-${crypto.randomUUID()}@example.invalid`,
            })
            .select('id')
            .single();
        if (custErr || !customer) throw new Error(custErr?.message);
        customerId = customer.id;
    });

    afterAll(async () => {
        if (customerId) {
            await supabaseAdmin.from('deployments').delete().eq('customer_id', customerId);
            await supabaseAdmin.from('customers').delete().eq('id', customerId);
        }
        if (catalogId) {
            await supabaseAdmin.from('catalogs').delete().eq('id', catalogId);
        }
        if (orgId) {
            await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        }
        if (groupId) {
            await supabaseAdmin.from('credential_groups').delete().eq('id', groupId);
        }
    });

    it('FEATURE_KEYS.QUOTATIONS y permisos existen en la base real y están asignados a pro/elite/enterprise (starter = false)', async () => {
        expect(FEATURE_KEYS.QUOTATIONS).toBe('quotations');
        expect(PERMISSION_KEYS.VIEW_QUOTATIONS).toBe('view_quotations');
        expect(PERMISSION_KEYS.MANAGE_QUOTATIONS).toBe('manage_quotations');

        const { data: pf } = await supabaseAdmin
            .from('plan_features')
            .select('plan_key, enabled')
            .eq('feature_key', 'quotations');

        const byPlan = new Map((pf ?? []).map((r) => [r.plan_key, r.enabled]));
        expect(byPlan.get('starter')).toBe(false);
        expect(byPlan.get('pro')).toBe(true);
        expect(byPlan.get('elite')).toBe(true);
        expect(byPlan.get('enterprise')).toBe(true);
    });

    it.each(ALL_CATALOG_ITEM_TYPES)('products.item_type acepta "%s" y deriva is_inventoriable correctamente', async (itemType) => {
        expect(isCatalogItemType(itemType)).toBe(true);
        const { data, error } = await supabaseAdmin
            .from('products')
            .insert({ catalog_id: catalogId, name: `Partida ${itemType}`, item_type: itemType })
            .select('id, item_type, is_inventoriable')
            .single();

        expect(error).toBeNull();
        expect(data?.item_type).toBe(itemType);
        expect(data?.is_inventoriable).toBe(itemType === CATALOG_ITEM_TYPES.PRODUCTO);

        if (data?.id) {
            await supabaseAdmin.from('products').delete().eq('id', data.id);
        }
    });

    it('products.item_type rechaza un valor fuera del dominio', async () => {
        expect(isCatalogItemType('paquete_raro')).toBe(false);
        const { error } = await supabaseAdmin
            .from('products')
            .insert({ catalog_id: catalogId, name: 'Invalido', item_type: 'paquete_raro' });
        expect(error?.code).toBe('23514');
    });

    it.each(ALL_BILLING_PERIODS)('billing_period "%s" es aceptado tanto en product_variants como en deployments', async (period) => {
        expect(isBillingPeriod(period)).toBe(true);

        const sku = `BP-${period.toUpperCase()}-${crypto.randomUUID().slice(0, 8)}`;
        const { data: variant, error: vErr } = await supabaseAdmin
            .from('product_variants')
            .insert({ product_id: productId, catalog_id: catalogId, sku, billing_period: period, price: 100 })
            .select('id, billing_period')
            .single();
        expect(vErr).toBeNull();
        expect(variant?.billing_period).toBe(period);
        if (variant?.id) {
            await supabaseAdmin.from('product_variants').delete().eq('id', variant.id);
        }

        const slug = `dep-${period}-${crypto.randomUUID().slice(0, 8)}`;
        const { data: dep, error: dErr } = await supabaseAdmin
            .from('deployments')
            .insert({
                customer_id: customerId,
                slug,
                plan_key: 'pro',
                billing_period: period,
            })
            .select('id, billing_period')
            .single();
        expect(dErr).toBeNull();
        expect(dep?.billing_period).toBe(period);
        if (dep?.id) {
            await supabaseAdmin.from('deployments').delete().eq('id', dep.id);
        }
    });

    it('billing_period rechaza un valor fuera del dominio en product_variants y deployments', async () => {
        expect(isBillingPeriod('trimestral')).toBe(false);
        expect(BILLING_PERIODS.UNICO).toBe('unico');

        const { error: vErr } = await supabaseAdmin
            .from('product_variants')
            .insert({ product_id: productId, catalog_id: catalogId, sku: 'BP-BAD', billing_period: 'trimestral' });
        expect(vErr?.code).toBe('23514');

        const { error: dErr } = await supabaseAdmin
            .from('deployments')
            .insert({ customer_id: customerId, slug: `bad-${Date.now()}`, plan_key: 'pro', billing_period: 'trimestral' });
        expect(dErr?.code).toBe('23514');
    });

    it.each(ALL_QUOTATION_STATUSES)('quotations.status acepta "%s"', async (status) => {
        expect(isQuotationStatus(status)).toBe(true);
        const { data: c, error: cErr } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: orgId,
                full_name: `Contacto ${status}`,
                email: `contacto-${status}-${crypto.randomUUID()}@example.invalid`,
            })
            .select('id')
            .single();
        expect(cErr).toBeNull();

        const { data, error } = await supabaseAdmin
            .from('quotations')
            .insert({
                organization_id: orgId,
                contact_id: c!.id,
                status,
                folio: status === QUOTATION_STATUSES.BORRADOR ? null : `COT-2026-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
            })
            .select('id, status')
            .single();

        expect(error).toBeNull();
        expect(data?.status).toBe(status);

        if (data?.id) {
            await supabaseAdmin.from('quotations').delete().eq('id', data.id);
        }
        if (c?.id) {
            await supabaseAdmin.from('contacts').delete().eq('id', c.id);
        }
    });

    it.each(ALL_QUOTATION_ORIGINS)('quotations.origin acepta "%s"', async (origin) => {
        expect(isQuotationOrigin(origin)).toBe(true);
        const { data, error } = await supabaseAdmin
            .from('quotations')
            .insert({
                organization_id: orgId,
                contact_id: contactId,
                status: 'abandonada',
                origin,
            })
            .select('id, origin')
            .single();

        expect(error).toBeNull();
        expect(data?.origin).toBe(origin);
        if (data?.id) {
            await supabaseAdmin.from('quotations').delete().eq('id', data.id);
        }
    });

    it.each(ALL_QUOTATION_CHANNELS)('quotations.last_channel acepta "%s"', async (channel) => {
        expect(isQuotationChannel(channel)).toBe(true);
        const { data, error } = await supabaseAdmin
            .from('quotations')
            .insert({
                organization_id: orgId,
                contact_id: contactId,
                status: 'abandonada',
                last_channel: channel,
            })
            .select('id, last_channel')
            .single();

        expect(error).toBeNull();
        expect(data?.last_channel).toBe(channel);
        if (data?.id) {
            await supabaseAdmin.from('quotations').delete().eq('id', data.id);
        }
    });

    it('quotation_deliveries y quotation_events aceptan todos los valores de sus dominios', async () => {
        const { data: q, error: qErr } = await supabaseAdmin
            .from('quotations')
            .insert({
                organization_id: orgId,
                contact_id: contactId,
                status: 'abandonada',
            })
            .select('id')
            .single();
        expect(qErr).toBeNull();

        for (const ch of ALL_QUOTATION_DELIVERY_CHANNELS) {
            expect(isQuotationDeliveryChannel(ch)).toBe(true);
            for (const st of ALL_QUOTATION_DELIVERY_STATUSES) {
                expect(isQuotationDeliveryStatus(st)).toBe(true);
                const { data: deliv, error: delivErr } = await supabaseAdmin
                    .from('quotation_deliveries')
                    .insert({
                        organization_id: orgId,
                        quotation_id: q!.id,
                        channel: ch,
                        status: st,
                        idempotency_key: `diag-${ch}-${st}-${crypto.randomUUID()}`,
                    })
                    .select('id')
                    .single();
                expect(delivErr).toBeNull();
                if (deliv?.id) {
                    await supabaseAdmin.from('quotation_deliveries').delete().eq('id', deliv.id);
                }
            }
        }

        for (const evType of ALL_QUOTATION_EVENT_TYPES) {
            expect(isQuotationEventType(evType)).toBe(true);
            const { error: evErr } = await supabaseAdmin
                .from('quotation_events')
                .insert({
                    organization_id: orgId,
                    quotation_id: q!.id,
                    event_type: evType,
                });
            expect(evErr).toBeNull();
        }

        for (const sender of ALL_QUOTATION_EMAIL_SENDERS) {
            expect(isQuotationEmailSender(sender)).toBe(true);
            const { error: sErr } = await supabaseAdmin
                .from('quotation_settings')
                .upsert({ organization_id: orgId, email_sender: sender }, { onConflict: 'organization_id' });
            expect(sErr).toBeNull();
        }
    });
});
