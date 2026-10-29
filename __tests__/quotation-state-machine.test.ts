import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { deleteTestOrganizations } from './helpers/test-data-sweeper.js';

/**
 * Máquina de estados e inmutabilidad de cotizaciones (77_quotations.sql,
 * triggers trg_quotations_guard, trg_quotation_items_guard y
 * trg_quotation_events_immutable). Cada rechazo tiene su contraparte de éxito.
 */
describe('Cotizaciones — máquina de estados e inmutabilidad (base real)', () => {
    let groupId: string;
    let orgId: string;
    const contactIds: string[] = [];

    async function createContact(): Promise<string> {
        const phone = `+5255${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
        const { data, error } = await supabaseAdmin
            .from('contacts')
            .insert({ organization_id: orgId, full_name: 'Contacto Estados', phone_e164: phone })
            .select('id')
            .single();
        if (error || !data) throw new Error(error?.message);
        contactIds.push(data.id);
        return data.id;
    }

    async function createDraftWithItem(): Promise<{ quotationId: string; itemId: string }> {
        const contactId = await createContact();
        const { data: q, error: qErr } = await supabaseAdmin
            .from('quotations')
            .insert({ organization_id: orgId, status: 'borrador', origin: 'dashboard', contact_id: contactId })
            .select('id')
            .single();
        if (qErr || !q) throw new Error(qErr?.message);

        const { data: item, error: iErr } = await supabaseAdmin
            .from('quotation_items')
            .insert({
                quotation_id: q.id,
                organization_id: orgId,
                line_number: 1,
                variant_id: crypto.randomUUID(),
                product_id: crypto.randomUUID(),
                catalog_id: crypto.randomUUID(),
                sku: 'SKU-ESTADOS',
                product_name: 'Producto Estados',
                quantity: 2,
                unit_price: 100,
                price_includes_tax: false,
                tax_rate: 0.16,
                line_subtotal: 200,
                line_tax: 32,
                line_total: 232,
            })
            .select('id')
            .single();
        if (iErr || !item) throw new Error(iErr?.message);
        return { quotationId: q.id, itemId: item.id };
    }

    async function setStatus(quotationId: string, status: string) {
        return supabaseAdmin.from('quotations').update({ status }).eq('id', quotationId);
    }

    async function emit(quotationId: string) {
        const { error } = await supabaseAdmin
            .from('quotations')
            .update({
                status: 'emitida',
                folio: `TEST-${crypto.randomUUID().slice(0, 8)}`,
                subtotal: 200,
                tax_total: 32,
                total: 232,
                issued_at: new Date().toISOString(),
            })
            .eq('id', quotationId);
        if (error) throw new Error(error.message);
    }

    beforeAll(async () => {
        const { data: group, error: gErr } = await supabaseAdmin
            .from('credential_groups')
            .insert({ name: 'Grupo Estados Cotizaciones' })
            .select('id')
            .single();
        if (gErr || !group) throw new Error(gErr?.message);
        groupId = group.id;

        const { data: org, error: oErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org Estados Cotizaciones',
                email: `org-quote-states-${crypto.randomUUID()}@example.invalid`,
                credential_group_id: groupId,
                plan_key: 'pro',
            })
            .select('id')
            .single();
        if (oErr || !org) throw new Error(oErr?.message);
        orgId = org.id;
    });

    afterAll(async () => {
        await deleteTestOrganizations(supabaseAdmin, [orgId]);
        if (groupId) await supabaseAdmin.from('credential_groups').delete().eq('id', groupId);
    });

    it('las partidas se editan en borrador y se rechazan tras emitir', async () => {
        const { quotationId, itemId } = await createDraftWithItem();

        const { error: draftEdit } = await supabaseAdmin
            .from('quotation_items')
            .update({ quantity: 3 })
            .eq('id', itemId);
        expect(draftEdit).toBeNull();

        await emit(quotationId);

        const { error: emittedEdit } = await supabaseAdmin
            .from('quotation_items')
            .update({ quantity: 5 })
            .eq('id', itemId);
        expect(emittedEdit?.message).toMatch(/solo pueden modificarse en estado borrador/);

        const { error: emittedDelete } = await supabaseAdmin.from('quotation_items').delete().eq('id', itemId);
        expect(emittedDelete?.message).toMatch(/solo pueden modificarse en estado borrador/);

        const { data: persisted } = await supabaseAdmin
            .from('quotation_items')
            .select('quantity')
            .eq('id', itemId)
            .single();
        expect(Number(persisted?.quantity)).toBe(3);
    });

    it('la cabecera emitida rechaza cambios de importes y acepta cambios de estado y PDF nulo', async () => {
        const { quotationId } = await createDraftWithItem();
        await emit(quotationId);

        const { error: totalEdit } = await supabaseAdmin
            .from('quotations')
            .update({ total: 1 })
            .eq('id', quotationId);
        expect(totalEdit?.message).toMatch(/inmutables/);

        const { error: pdfFill } = await supabaseAdmin
            .from('quotations')
            .update({ pdf_storage_path: 'org/2026/TEST.pdf', pdf_sha256: 'abc' })
            .eq('id', quotationId);
        expect(pdfFill).toBeNull();

        const { error: pdfOverwrite } = await supabaseAdmin
            .from('quotations')
            .update({ pdf_storage_path: 'org/2026/OTRO.pdf' })
            .eq('id', quotationId);
        expect(pdfOverwrite?.message).toMatch(/PDF de una cotización emitida es inmutable/);

        const { error: toSent } = await setStatus(quotationId, 'enviada');
        expect(toSent).toBeNull();
    });

    it('rechaza transiciones inválidas y acepta las válidas', async () => {
        // borrador → aceptada: inválida; borrador → emitida: válida
        const a = await createDraftWithItem();
        expect((await setStatus(a.quotationId, 'aceptada')).error?.message).toMatch(/no permitida/);
        await emit(a.quotationId);

        // emitida → borrador / abandonada: inválidas; emitida → enviada → aceptada → convertida: válidas
        expect((await setStatus(a.quotationId, 'borrador')).error?.message).toMatch(/no permitida/);
        expect((await setStatus(a.quotationId, 'abandonada')).error?.message).toMatch(/no permitida/);
        expect((await setStatus(a.quotationId, 'enviada')).error).toBeNull();
        expect((await setStatus(a.quotationId, 'emitida')).error?.message).toMatch(/no permitida/);
        expect((await setStatus(a.quotationId, 'aceptada')).error).toBeNull();
        expect((await setStatus(a.quotationId, 'rechazada')).error?.message).toMatch(/no permitida/);
        expect((await setStatus(a.quotationId, 'convertida')).error).toBeNull();

        // borrador → abandonada → borrador: válidas; abandonada → emitida: inválida
        const b = await createDraftWithItem();
        expect((await setStatus(b.quotationId, 'abandonada')).error).toBeNull();
        expect((await setStatus(b.quotationId, 'emitida')).error?.message).toMatch(/no permitida/);
        expect((await setStatus(b.quotationId, 'borrador')).error).toBeNull();

        // Estados terminales: cancelada no regresa
        const c = await createDraftWithItem();
        expect((await setStatus(c.quotationId, 'cancelada')).error).toBeNull();
        expect((await setStatus(c.quotationId, 'borrador')).error?.message).toMatch(/no permitida/);
    });

    it('borrar un usuario que actuó sobre una cotización deja su evento con actor_user_id NULL (migración 79)', async () => {
        const { quotationId } = await createDraftWithItem();
        const { data: created, error: userErr } = await supabaseAdmin.auth.admin.createUser({
            email: `test-quot-actor-${crypto.randomUUID()}@example.invalid`,
            password: `Pw-${crypto.randomUUID()}`,
            email_confirm: true,
        });
        if (userErr || !created.user) throw new Error(userErr?.message);

        const { data: ev, error: evErr } = await supabaseAdmin
            .from('quotation_events')
            .insert({
                organization_id: orgId,
                quotation_id: quotationId,
                event_type: 'revisada',
                actor_user_id: created.user.id,
                payload: { nota: 'evento con actor' },
            })
            .select('id')
            .single();
        expect(evErr).toBeNull();

        const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(created.user.id);
        expect(delErr).toBeNull();

        const { data: after } = await supabaseAdmin
            .from('quotation_events')
            .select('actor_user_id, event_type, payload')
            .eq('id', ev!.id)
            .single();
        expect(after).toEqual({ actor_user_id: null, event_type: 'revisada', payload: { nota: 'evento con actor' } });
    });

    it('quotation_events es append-only: inserta, pero rechaza UPDATE y DELETE directos', async () => {
        const { quotationId } = await createDraftWithItem();
        const { data: ev, error: insErr } = await supabaseAdmin
            .from('quotation_events')
            .insert({ organization_id: orgId, quotation_id: quotationId, event_type: 'carrito_creado' })
            .select('id')
            .single();
        expect(insErr).toBeNull();

        const { error: updErr } = await supabaseAdmin
            .from('quotation_events')
            .update({ payload: { x: 1 } })
            .eq('id', ev!.id);
        expect(updErr?.message).toMatch(/append-only/);

        const { error: delErr } = await supabaseAdmin.from('quotation_events').delete().eq('id', ev!.id);
        expect(delErr?.message).toMatch(/append-only/);
    });
});
