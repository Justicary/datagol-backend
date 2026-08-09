import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ALL_LEAD_TEMPERATURES, ALL_LEAD_FOLLOWUP_STATUSES, ALL_LEAD_CHANNELS } from '../src/types/lead-enums.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * Usa una organización dedicada y desechable (no una compartida con otros
 * archivos de test) para evitar condiciones de carrera entre archivos que
 * vitest ejecuta en paralelo — ver __tests__/secret-keys.test.ts para el
 * incidente que motivó este patrón.
 */
describe('src/types/lead-enums.ts — sincronizado con los CHECK constraints reales de leads', () => {
    let testOrgId: string;

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Test Org (lead-enums.test.ts)', email: 'test-lead-enums@example.invalid' })
            .select('id')
            .single();
        if (error || !data) {
            throw new Error(`No se pudo crear la organización dedicada de la prueba: ${error?.message}`);
        }
        testOrgId = data.id;
    });

    afterAll(async () => {
        if (testOrgId) {
            await supabaseAdmin.from('organizations').delete().eq('id', testOrgId);
        }
    });

    it.each(ALL_LEAD_TEMPERATURES)('la temperatura "%s" es aceptada por el CHECK constraint de leads.temperature', async (temperature) => {
        const conversationId = `diag-temp-${Math.random().toString(36).slice(2)}`;
        const { error } = await supabaseAdmin
            .from('leads')
            .insert({ organization_id: testOrgId, channel: 'voice', conversation_id: conversationId, temperature })
            .select('id')
            .single();

        expect(error?.code).not.toBe('23514');

        await supabaseAdmin.from('leads').delete().eq('conversation_id', conversationId);
    });

    it.each(ALL_LEAD_FOLLOWUP_STATUSES)('el estado "%s" es aceptado por el CHECK constraint de leads.followup_status', async (followupStatus) => {
        const conversationId = `diag-fs-${Math.random().toString(36).slice(2)}`;
        const { error } = await supabaseAdmin
            .from('leads')
            .insert({ organization_id: testOrgId, channel: 'voice', conversation_id: conversationId, followup_status: followupStatus })
            .select('id')
            .single();

        expect(error?.code).not.toBe('23514');

        await supabaseAdmin.from('leads').delete().eq('conversation_id', conversationId);
    });

    it.each(ALL_LEAD_CHANNELS)('el canal "%s" es aceptado por el CHECK constraint de leads.channel', async (channel) => {
        const conversationId = `diag-channel-${Math.random().toString(36).slice(2)}`;
        const { error } = await supabaseAdmin
            .from('leads')
            .insert({ organization_id: testOrgId, channel, conversation_id: conversationId })
            .select('id')
            .single();

        expect(error?.code).not.toBe('23514');

        await supabaseAdmin.from('leads').delete().eq('conversation_id', conversationId);
    });

    it('contraparte de rechazo: un canal fuera de la lista es rechazado por el CHECK constraint (leads_channel_check)', async () => {
        const conversationId = `diag-channel-invalido-${Math.random().toString(36).slice(2)}`;
        const { error } = await supabaseAdmin
            .from('leads')
            .insert({ organization_id: testOrgId, channel: 'telegram', conversation_id: conversationId })
            .select('id')
            .single();

        expect(error?.code).toBe('23514');
    });
});
