import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import { deleteTestOrganizations } from './helpers/test-data-sweeper.js';

/**
 * Migración 78: `admin_delete_organizations_cascade` borra con replica solo las
 * filas append-only y deja que las FKs con cascada eliminen el resto, y ya no
 * es ejecutable con la llave pública.
 */
describe('admin_delete_organizations_cascade (migración 78)', () => {
    const env = validateEnv();
    const createdOrgIds: string[] = [];

    afterAll(async () => {
        await deleteTestOrganizations(supabaseAdmin, createdOrgIds);
    });

    async function createOrg(label: string): Promise<string> {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: `Org Delete Cascade ${label}`, email: `org-del-cascade-${crypto.randomUUID()}@example.invalid` })
            .select('id')
            .single();
        if (error || !data) throw new Error(error?.message);
        createdOrgIds.push(data.id);
        return data.id;
    }

    it('la llave pública (anon) no puede ejecutarla; el service role sí', async () => {
        const orgId = await createOrg('anon');
        const anon = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY, {
            auth: { persistSession: false },
        });

        const { error: anonErr } = await anon.rpc('admin_delete_organizations_cascade', {
            p_organization_ids: [orgId],
        });
        expect(anonErr).not.toBeNull();
        const { data: stillThere } = await supabaseAdmin.from('organizations').select('id').eq('id', orgId).maybeSingle();
        expect(stillThere?.id).toBe(orgId);

        const { data, error } = await supabaseAdmin.rpc('admin_delete_organizations_cascade', {
            p_organization_ids: [orgId],
        });
        expect(error).toBeNull();
        expect((data as { deletedCount: number }).deletedCount).toBe(1);
    });

    it('borra una organización con usage_events, catálogo y cotización emitida sin dejar huérfanos', async () => {
        const orgId = await createOrg('full');

        const { data: catalog } = await supabaseAdmin
            .from('catalogs')
            .insert({ owner_organization_id: orgId, name: 'Catálogo Delete Cascade' })
            .select('id')
            .single();
        const { data: product } = await supabaseAdmin
            .from('products')
            .insert({ catalog_id: catalog!.id, name: 'Producto Delete Cascade' })
            .select('id')
            .single();
        const { data: contact } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: orgId,
                full_name: 'Contacto Delete Cascade',
                phone_e164: `+5255${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
            })
            .select('id')
            .single();
        const { data: quotation } = await supabaseAdmin
            .from('quotations')
            .insert({ organization_id: orgId, status: 'borrador', origin: 'dashboard', contact_id: contact!.id })
            .select('id')
            .single();
        await supabaseAdmin.from('quotation_items').insert({
            quotation_id: quotation!.id,
            organization_id: orgId,
            line_number: 1,
            variant_id: crypto.randomUUID(),
            product_id: product!.id,
            catalog_id: catalog!.id,
            sku: 'DEL-1',
            product_name: 'Producto Delete Cascade',
            quantity: 1,
            unit_price: 100,
        });
        await supabaseAdmin.from('quotation_events').insert({
            organization_id: orgId,
            quotation_id: quotation!.id,
            event_type: 'carrito_creado',
        });
        const { error: emitErr } = await supabaseAdmin
            .from('quotations')
            .update({ status: 'emitida', folio: `DEL-${crypto.randomUUID().slice(0, 8)}`, total: 116 })
            .eq('id', quotation!.id);
        expect(emitErr).toBeNull();

        const { error: usageErr } = await supabaseAdmin.from('usage_events').insert({
            organization_id: orgId,
            provider: 'meta',
            unit_type: 'wa_service_mx',
            quantity: 1,
            unit_rate_usd: 0.01,
            idempotency_key: `del-cascade:${crypto.randomUUID()}`,
        });
        expect(usageErr).toBeNull();

        // Contraparte: el DELETE directo queda bloqueado por la fila append-only.
        const { error: directErr } = await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        expect(directErr?.message).toMatch(/append-only/);

        const { data, error } = await supabaseAdmin.rpc('admin_delete_organizations_cascade', {
            p_organization_ids: [orgId],
        });
        expect(error).toBeNull();
        expect((data as { deletedCount: number }).deletedCount).toBe(1);

        const remaining = await Promise.all([
            supabaseAdmin.from('organizations').select('id').eq('id', orgId),
            supabaseAdmin.from('catalogs').select('id').eq('id', catalog!.id),
            supabaseAdmin.from('products').select('id').eq('id', product!.id),
            supabaseAdmin.from('contacts').select('id').eq('id', contact!.id),
            supabaseAdmin.from('quotations').select('id').eq('id', quotation!.id),
            supabaseAdmin.from('quotation_items').select('id').eq('quotation_id', quotation!.id),
            supabaseAdmin.from('quotation_events').select('id').eq('quotation_id', quotation!.id),
            supabaseAdmin.from('usage_events').select('id').eq('organization_id', orgId),
        ]);
        for (const { data: rows, error: readErr } of remaining) {
            expect(readErr).toBeNull();
            expect(rows ?? []).toHaveLength(0);
        }
    });
});
