import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { ALL_LEAD_SOURCES, isLeadSource } from '../src/types/lead-source.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * src/types/lead-source.ts es la única fuente de verdad para el CHECK
 * constraint de leads.source (db/migrations/39_resultado_negocio.sql). No
 * confía en esa lista por sí misma: inserta cada valor contra la base real.
 */
describe('src/types/lead-source.ts — sincronizado con el CHECK constraint real de leads.source', () => {
    let testOrgId: string;

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Test Org (lead-source.test.ts)', email: `test-lead-source-${crypto.randomUUID()}@example.invalid` })
            .select('id')
            .single();
        if (error || !data) {
            throw new Error(`No se pudo crear la organización dedicada de la prueba: ${error?.message}`);
        }
        testOrgId = data.id;
    });

    afterAll(async () => {
        if (testOrgId) {
            await supabaseAdmin.from('leads').delete().eq('organization_id', testOrgId);
            await supabaseAdmin.from('organizations').delete().eq('id', testOrgId);
        }
    });

    it.each(ALL_LEAD_SOURCES)('el origen "%s" es aceptado por el CHECK constraint de leads.source', async (source) => {
        const { data, error } = await supabaseAdmin
            .from('leads')
            .insert({
                organization_id: testOrgId,
                channel: 'voice',
                conversation_id: `conv-lead-source-${crypto.randomUUID()}`,
                source,
            })
            .select('id')
            .single();

        expect(error?.code).not.toBe('23514');

        if (data) {
            await supabaseAdmin.from('leads').delete().eq('id', data.id);
        }
    });

    it('isLeadSource rechaza texto libre que no encaja en ningún valor', () => {
        expect(isLeadSource('facebook ads')).toBe(false);
        expect(isLeadSource('')).toBe(false);
    });

    it('contraparte de éxito: isLeadSource acepta los 9 valores reales', () => {
        for (const source of ALL_LEAD_SOURCES) {
            expect(isLeadSource(source)).toBe(true);
        }
    });
});
