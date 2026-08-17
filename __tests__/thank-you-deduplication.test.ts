import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { supabaseAdmin } from '../src/lib/supabase.js';

const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

describe('Agradecimiento Automático — Deduplicación y Concurrencia (DB & RPC)', () => {
    let testContactId: string;
    const testPhone = `+52155${Math.floor(10000000 + Math.random() * 89999999)}`;
    const createdSendIds: string[] = [];

    beforeAll(async () => {
        const { data: contact, error } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: REAL_ORG_ID,
                phone_e164: testPhone,
                full_name: 'Prospecto Deduplicación Test',
                email: `dedupe-test-${Date.now()}@example.invalid`,
                opted_out: false,
            })
            .select('id')
            .single();

        if (error || !contact) {
            throw new Error(`Error al crear contacto para pruebas de deduplicación: ${error?.message}`);
        }
        testContactId = contact.id;
    });

    afterAll(async () => {
        if (testContactId) {
            await supabaseAdmin.from('thank_you_sends').delete().eq('contact_id', testContactId);
            await supabaseAdmin.from('contacts').delete().eq('id', testContactId);
        }
    });

    it('PRUEBA CENTRAL: un contacto con 3 interacciones el mismo día recibe exactamente 1 envío; las otras 2 se registran como omitidas', async () => {
        // 1. Primera interacción (p. ej. llamada de voz captada)
        const { data: res1, error: err1 } = await supabaseAdmin.rpc('register_thank_you_attempt', {
            p_organization_id: REAL_ORG_ID,
            p_contact_id: testContactId,
            p_lead_id: null,
            p_channel: 'email',
            p_dedupe_window_days: 30,
        });

        expect(err1).toBeNull();
        expect(res1.allowed).toBe(true);
        expect(res1.send_id).toBeDefined();
        createdSendIds.push(res1.send_id);

        // Simulamos que el primer envío pasa a 'enviado'
        await supabaseAdmin
            .from('thank_you_sends')
            .update({ status: 'enviado', sent_at: new Date().toISOString() })
            .eq('id', res1.send_id);

        // 2. Segunda interacción en la misma tarde (p. ej. escribió por WhatsApp)
        const { data: res2, error: err2 } = await supabaseAdmin.rpc('register_thank_you_attempt', {
            p_organization_id: REAL_ORG_ID,
            p_contact_id: testContactId,
            p_lead_id: null,
            p_channel: 'whatsapp',
            p_dedupe_window_days: 30,
        });

        expect(err2).toBeNull();
        expect(res2.allowed).toBe(false);
        expect(res2.skip_reason).toBe('en_ventana_deduplicacion');
        createdSendIds.push(res2.send_id);

        // 3. Tercera interacción en la misma tarde (p. ej. llenó formulario web)
        const { data: res3, error: err3 } = await supabaseAdmin.rpc('register_thank_you_attempt', {
            p_organization_id: REAL_ORG_ID,
            p_contact_id: testContactId,
            p_lead_id: null,
            p_channel: 'email',
            p_dedupe_window_days: 30,
        });

        expect(err3).toBeNull();
        expect(res3.allowed).toBe(false);
        expect(res3.skip_reason).toBe('en_ventana_deduplicacion');
        createdSendIds.push(res3.send_id);

        // 4. Verificar auditoría en thank_you_sends
        const { data: sends } = await supabaseAdmin
            .from('thank_you_sends')
            .select('status, skip_reason')
            .eq('contact_id', testContactId);

        expect(sends).toHaveLength(3);
        const sentCount = sends?.filter((s) => s.status === 'enviado').length;
        const omittedCount = sends?.filter((s) => s.status === 'omitido' && s.skip_reason === 'en_ventana_deduplicacion').length;

        expect(sentCount).toBe(1);
        expect(omittedCount).toBe(2);
    });

    it('un contacto con envío previo fuera de la ventana (p. ej. ventana de 1 día y envío hace 2 días) recibe un nuevo agradecimiento', async () => {
        // Creamos un contacto secundario para esta prueba
        const phone2 = `+52155${Math.floor(10000000 + Math.random() * 89999999)}`;
        const { data: contact2 } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: REAL_ORG_ID,
                phone_e164: phone2,
                full_name: 'Prospecto Ventana Expirada',
                opted_out: false,
            })
            .select('id')
            .single();

        expect(contact2).toBeDefined();
        const contact2Id = contact2!.id;

        try {
            // Simulamos un envío de hace 40 días
            const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
            await supabaseAdmin.from('thank_you_sends').insert({
                organization_id: REAL_ORG_ID,
                contact_id: contact2Id,
                channel: 'email',
                status: 'enviado',
                sent_at: fortyDaysAgo,
                created_at: fortyDaysAgo,
            });

            // Nuevo intento con ventana de 30 días -> Debe permitirse (allowed: true)
            const { data: newAttempt, error } = await supabaseAdmin.rpc('register_thank_you_attempt', {
                p_organization_id: REAL_ORG_ID,
                p_contact_id: contact2Id,
                p_lead_id: null,
                p_channel: 'email',
                p_dedupe_window_days: 30,
            });

            expect(error).toBeNull();
            expect(newAttempt.allowed).toBe(true);
        } finally {
            await supabaseAdmin.from('thank_you_sends').delete().eq('contact_id', contact2Id);
            await supabaseAdmin.from('contacts').delete().eq('id', contact2Id);
        }
    });

    it('concurrencia atómica: múltiples peticiones concurrentes para el mismo contacto producen exactamente 1 permitido', async () => {
        // Creamos un contacto para prueba de concurrencia
        const phone3 = `+52155${Math.floor(10000000 + Math.random() * 89999999)}`;
        const { data: contact3 } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: REAL_ORG_ID,
                phone_e164: phone3,
                full_name: 'Prospecto Concurrente',
                opted_out: false,
            })
            .select('id')
            .single();

        expect(contact3).toBeDefined();
        const contact3Id = contact3!.id;

        try {
            // Disparamos 5 llamadas al RPC en paralelo exacto
            const promises = Array.from({ length: 5 }).map((_, i) =>
                supabaseAdmin.rpc('register_thank_you_attempt', {
                    p_organization_id: REAL_ORG_ID,
                    p_contact_id: contact3Id,
                    p_lead_id: null,
                    p_channel: i % 2 === 0 ? 'email' : 'whatsapp',
                    p_dedupe_window_days: 30,
                })
            );

            const results = await Promise.all(promises);

            const allowedCount = results.filter((r) => r.data?.allowed === true).length;
            const deniedCount = results.filter((r) => r.data?.allowed === false).length;

            expect(allowedCount).toBe(1);
            expect(deniedCount).toBe(4);
        } finally {
            await supabaseAdmin.from('thank_you_sends').delete().eq('contact_id', contact3Id);
            await supabaseAdmin.from('contacts').delete().eq('id', contact3Id);
        }
    });
});
