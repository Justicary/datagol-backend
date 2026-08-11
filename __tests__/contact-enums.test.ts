import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    ALL_CONTACT_LIFECYCLE_STAGES,
    ALL_CONTACT_PIPELINE_STAGES,
    ALL_CONTACT_ADDRESS_TYPES,
    CONTACT_LIFECYCLE_STAGES,
    CONTACT_PIPELINE_STAGES,
    isLifecyclePipelineCoherent,
} from '../src/types/contact-enums.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * Organización dedicada y desechable por archivo (ver __tests__/lead-enums.test.ts)
 * para evitar condiciones de carrera con otros archivos de test en paralelo.
 */
describe('src/types/contact-enums.ts — sincronizado con los CHECK constraints reales', () => {
    let testOrgId: string;
    let testContactId: string;

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Test Org (contact-enums.test.ts)', email: `test-contact-enums-${Date.now()}@example.invalid` })
            .select('id')
            .single();
        if (error || !data) throw new Error(`No se pudo crear la organización dedicada: ${error?.message}`);
        testOrgId = data.id;

        const { data: contactId, error: rcError } = await supabaseAdmin.rpc('resolve_contact', {
            p_org_id: testOrgId,
            p_phone: `+52165${Math.floor(Math.random() * 9000000 + 1000000)}`,
            p_email: null,
        });
        if (rcError || !contactId) throw new Error(`No se pudo crear el contacto de prueba: ${rcError?.message}`);
        testContactId = contactId;
    });

    afterAll(async () => {
        if (testOrgId) {
            await supabaseAdmin.from('contacts').delete().eq('organization_id', testOrgId);
            await supabaseAdmin.from('organizations').delete().eq('id', testOrgId);
        }
    });

    it.each(ALL_CONTACT_ADDRESS_TYPES)('address_type "%s" es aceptado por contact_addresses_address_type_check', async (addressType) => {
        const street = `Calle de prueba ${Math.random().toString(36).slice(2)}`;
        const { error } = await supabaseAdmin
            .from('contact_addresses')
            .insert({ organization_id: testOrgId, contact_id: testContactId, street, address_type: addressType })
            .select('id')
            .single();

        expect(error?.code).not.toBe('23514');

        await supabaseAdmin.from('contact_addresses').delete().eq('contact_id', testContactId).eq('street', street);
    });

    it('contraparte de rechazo: un address_type fuera de la lista es rechazado (23514)', async () => {
        const { error } = await supabaseAdmin
            .from('contact_addresses')
            .insert({ organization_id: testOrgId, contact_id: testContactId, street: 'Calle inválida', address_type: 'oficina' });

        expect(error?.code).toBe('23514');
    });

    // Coherencia lifecycle/pipeline: se prueban las 18 combinaciones posibles
    // contra la base real, no solo la tabla en memoria de isLifecyclePipelineCoherent
    // — si la base cambia el CHECK, este test debe fallar y avisar del drift.
    for (const lifecycle of ALL_CONTACT_LIFECYCLE_STAGES) {
        for (const pipeline of ALL_CONTACT_PIPELINE_STAGES) {
            const expectedCoherent = isLifecyclePipelineCoherent(lifecycle, pipeline);
            it(`lifecycle_stage="${lifecycle}" + pipeline_stage="${pipeline}" ${expectedCoherent ? 'es coherente' : 'viola contacts_lifecycle_pipeline_coherent'}`, async () => {
                const payload: Record<string, unknown> = { lifecycle_stage: lifecycle, pipeline_stage: pipeline };
                if (pipeline === CONTACT_PIPELINE_STAGES.GANADO) payload.won_at = new Date().toISOString();
                if (pipeline === CONTACT_PIPELINE_STAGES.PERDIDO) payload.lost_reason = 'Prueba automatizada';

                const { error } = await supabaseAdmin.from('contacts').update(payload).eq('id', testContactId);

                if (expectedCoherent) {
                    expect(error?.code).not.toBe('23514');
                } else {
                    expect(error?.code).toBe('23514');
                }
            });
        }
    }

    it('contraparte de éxito: un lifecycle_stage/pipeline_stage válidos y coherentes se guardan sin error', async () => {
        const { error } = await supabaseAdmin
            .from('contacts')
            .update({ lifecycle_stage: CONTACT_LIFECYCLE_STAGES.PROSPECTO, pipeline_stage: CONTACT_PIPELINE_STAGES.CONTACTADO })
            .eq('id', testContactId);
        expect(error).toBeNull();

        const { data } = await supabaseAdmin.from('contacts').select('lifecycle_stage, pipeline_stage').eq('id', testContactId).single();
        expect(data?.lifecycle_stage).toBe(CONTACT_LIFECYCLE_STAGES.PROSPECTO);
        expect(data?.pipeline_stage).toBe(CONTACT_PIPELINE_STAGES.CONTACTADO);
    });
});
