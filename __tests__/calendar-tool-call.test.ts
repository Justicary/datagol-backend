import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../src/lib/supabase.js';

vi.mock('../src/services/cal-com-tool-client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/services/cal-com-tool-client.js')>();
    return {
        ...actual,
        getAvailableSlots: vi.fn(),
        createBooking: vi.fn(),
        rescheduleBooking: vi.fn(),
        cancelBooking: vi.fn(),
    };
});

import { getAvailableSlots, createBooking, rescheduleBooking, cancelBooking } from '../src/services/cal-com-tool-client.js';
import { handleCalendarToolCall } from '../src/services/calendar.js';

// Organización real existente con cal_event_type_id configurado (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

function fakeFastify(): FastifyInstance {
    return { log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as unknown as FastifyInstance;
}

describe('services/calendar.ts handleCalendarToolCall (tool-calling de Vapi)', () => {
    let otherOrgId: string;
    const createdAppointmentIds: string[] = [];

    beforeAll(async () => {
        const { data } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org B Calendar Tool Call Isolation', email: `org-b-calendar-toolcall-${Date.now()}@example.invalid` })
            .select('id')
            .single();
        otherOrgId = data!.id;
    });

    afterAll(async () => {
        if (createdAppointmentIds.length > 0) {
            await supabaseAdmin.from('appointments').delete().in('id', createdAppointmentIds);
        }
        await supabaseAdmin.from('organizations').delete().eq('id', otherOrgId);
    });

    beforeEach(() => {
        vi.mocked(getAvailableSlots).mockReset();
        vi.mocked(createBooking).mockReset();
        vi.mocked(rescheduleBooking).mockReset();
        vi.mocked(cancelBooking).mockReset();
    });

    it('checkAvailability delega en cal-com-tool-client con las credenciales del organizationId resuelto, nunca de args', async () => {
        vi.mocked(getAvailableSlots).mockResolvedValue([{ time: '2026-09-01T10:00:00Z' }]);

        const result = await handleCalendarToolCall(fakeFastify(), REAL_ORG_ID, 'checkAvailability', {
            startTime: '2026-09-01T00:00:00Z',
            endTime: '2026-09-02T00:00:00Z',
            // organizationId falsificado en los args del LLM: debe ignorarse por completo.
            organizationId: otherOrgId,
        });

        expect(result).toContain('2026-09-01T10:00:00Z');
        expect(vi.mocked(getAvailableSlots)).toHaveBeenCalledWith(
            expect.anything(),
            REAL_ORG_ID,
            expect.objectContaining({}),
            expect.anything()
        );
    });

    it('bookAppointment sin teléfono ni correo responde pidiendo uno de los dos, sin llamar a Cal.com', async () => {
        const result = await handleCalendarToolCall(fakeFastify(), REAL_ORG_ID, 'bookAppointment', {
            customerName: 'Cliente Sin Contacto Vapi',
            startTime: '2026-09-03T10:00:00Z',
        });

        expect(result).toContain('teléfono');
        expect(vi.mocked(createBooking)).not.toHaveBeenCalled();
    });

    it('contraparte de éxito: bookAppointment crea la cita y la escribe en appointments con el organizationId correcto', async () => {
        vi.mocked(createBooking).mockResolvedValue({
            calBookingId: 'cal_booking_vapi_test',
            startTime: '2026-09-04T10:00:00.000Z',
            endTime: '2026-09-04T10:30:00.000Z',
        });

        const result = await handleCalendarToolCall(fakeFastify(), REAL_ORG_ID, 'bookAppointment', {
            customerName: 'Cliente Vapi Éxito',
            customerPhone: '+525599911122',
            startTime: '2026-09-04T10:00:00Z',
        });

        expect(result).toContain('Cita agendada correctamente');

        const { data: appointment } = await supabaseAdmin
            .from('appointments')
            .select('id, organization_id')
            .eq('cal_booking_id', 'cal_booking_vapi_test')
            .single();
        expect(appointment?.organization_id).toBe(REAL_ORG_ID);
        createdAppointmentIds.push(appointment!.id);
    });

    it('aislamiento multi-tenant: rescheduleAppointment no encuentra una cita de otra organización aunque se le pase su id', async () => {
        const { data: foreignAppointment } = await supabaseAdmin
            .from('appointments')
            .insert({
                organization_id: otherOrgId,
                customer_name: 'Cliente De Otra Org',
                customer_phone: '+525588822211',
                start_time: '2026-09-10T10:00:00.000Z',
                end_time: '2026-09-10T10:30:00.000Z',
                cal_booking_id: 'cal_booking_foreign',
                status: 'confirmed',
            })
            .select('id')
            .single();
        createdAppointmentIds.push(foreignAppointment!.id);

        const result = await handleCalendarToolCall(fakeFastify(), REAL_ORG_ID, 'rescheduleAppointment', {
            appointmentId: foreignAppointment!.id,
            newStartTime: '2026-09-11T10:00:00Z',
        });

        expect(result).toContain('No encontré esa cita');
        expect(vi.mocked(rescheduleBooking)).not.toHaveBeenCalled();
    });

    it('aislamiento multi-tenant: cancelAppointment no cancela una cita de otra organización aunque se le pase su calBookingId', async () => {
        const { data: foreignAppointment } = await supabaseAdmin
            .from('appointments')
            .insert({
                organization_id: otherOrgId,
                customer_name: 'Cliente De Otra Org Cancel',
                customer_phone: '+525588822233',
                start_time: '2026-09-12T10:00:00.000Z',
                end_time: '2026-09-12T10:30:00.000Z',
                cal_booking_id: 'cal_booking_foreign_cancel',
                status: 'confirmed',
            })
            .select('id')
            .single();
        createdAppointmentIds.push(foreignAppointment!.id);

        const result = await handleCalendarToolCall(fakeFastify(), REAL_ORG_ID, 'cancelAppointment', {
            calBookingId: 'cal_booking_foreign_cancel',
        });

        expect(result).toContain('No encontré esa cita');
        expect(vi.mocked(cancelBooking)).not.toHaveBeenCalled();

        const { data: unchanged } = await supabaseAdmin.from('appointments').select('status').eq('id', foreignAppointment!.id).single();
        expect(unchanged?.status).toBe('confirmed');
    });
});
