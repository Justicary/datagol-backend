import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { ALL_APPOINTMENT_STATUSES, isAppointmentStatus } from '../src/types/appointment-status.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * src/types/appointment-status.ts es la única fuente de verdad para
 * appointments_status_check (db/migrations/39_resultado_negocio.sql). Esta
 * prueba no confía en esa lista por sí misma: inserta cada valor contra la
 * base real y falla si el CHECK constraint lo rechaza.
 *
 * Usa una organización dedicada y desechable (no una compartida con otros
 * archivos de test) — mismo motivo que secret-keys.test.ts: evitar
 * condiciones de carrera entre archivos de test que vitest podría ejecutar
 * en paralelo.
 */
describe('src/types/appointment-status.ts — sincronizado con el CHECK constraint real de appointments.status', () => {
    let testOrgId: string;

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Test Org (appointment-status.test.ts)', email: `test-appointment-status-${crypto.randomUUID()}@example.invalid` })
            .select('id')
            .single();
        if (error || !data) {
            throw new Error(`No se pudo crear la organización dedicada de la prueba: ${error?.message}`);
        }
        testOrgId = data.id;
    });

    afterAll(async () => {
        if (testOrgId) {
            await supabaseAdmin.from('appointments').delete().eq('organization_id', testOrgId);
            await supabaseAdmin.from('organizations').delete().eq('id', testOrgId);
        }
    });

    it.each(ALL_APPOINTMENT_STATUSES)('el estado "%s" es aceptado por appointments_status_check', async (status) => {
        const startTime = new Date().toISOString();
        const endTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();

        const { data, error } = await supabaseAdmin
            .from('appointments')
            .insert({
                organization_id: testOrgId,
                customer_name: 'Prueba de estado',
                start_time: startTime,
                end_time: endTime,
                status,
            })
            .select('id')
            .single();

        expect(error?.code).not.toBe('23514');

        if (data) {
            await supabaseAdmin.from('appointments').delete().eq('id', data.id);
        }
    });

    it('isAppointmentStatus rechaza vocabulario viejo en inglés', () => {
        expect(isAppointmentStatus('confirmed')).toBe(false);
        expect(isAppointmentStatus('cancelled')).toBe(false);
        expect(isAppointmentStatus('rescheduled')).toBe(false);
    });

    it('contraparte de éxito: isAppointmentStatus acepta los 6 valores reales', () => {
        for (const status of ALL_APPOINTMENT_STATUSES) {
            expect(isAppointmentStatus(status)).toBe(true);
        }
    });
});
