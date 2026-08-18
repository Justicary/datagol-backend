import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { ALL_DEAL_CURRENCIES, isDealCurrency } from '../src/types/deal-currency.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * src/types/deal-currency.ts es la única fuente de verdad para el CHECK
 * constraint de contacts.deal_currency (db/migrations/39_resultado_negocio.sql).
 */
describe('src/types/deal-currency.ts — sincronizado con el CHECK constraint real de contacts.deal_currency', () => {
    let testOrgId: string;

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Test Org (deal-currency.test.ts)', email: `test-deal-currency-${crypto.randomUUID()}@example.invalid` })
            .select('id')
            .single();
        if (error || !data) {
            throw new Error(`No se pudo crear la organización dedicada de la prueba: ${error?.message}`);
        }
        testOrgId = data.id;
    });

    afterAll(async () => {
        if (testOrgId) {
            await supabaseAdmin.from('contacts').delete().eq('organization_id', testOrgId);
            await supabaseAdmin.from('organizations').delete().eq('id', testOrgId);
        }
    });

    it.each(ALL_DEAL_CURRENCIES)('la moneda "%s" es aceptada por el CHECK constraint de contacts.deal_currency', async (currency) => {
        const { data, error } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: testOrgId,
                full_name: 'Prueba de moneda',
                // contacts_identity_present (migración 25) exige phone_e164 o
                // email — full_name solo no basta para pasar el INSERT.
                phone_e164: `+5255${Math.floor(Math.random() * 90000000 + 10000000)}`,
                deal_currency: currency,
            })
            .select('id')
            .single();

        expect(error?.code).not.toBe('23514');

        if (data) {
            await supabaseAdmin.from('contacts').delete().eq('id', data.id);
        }
    });

    it('isDealCurrency rechaza otras monedas', () => {
        expect(isDealCurrency('EUR')).toBe(false);
        expect(isDealCurrency('mxn')).toBe(false); // sensible a mayúsculas, igual que el CHECK
    });

    it('contraparte de éxito: isDealCurrency acepta MXN y USD', () => {
        for (const currency of ALL_DEAL_CURRENCIES) {
            expect(isDealCurrency(currency)).toBe(true);
        }
    });
});
