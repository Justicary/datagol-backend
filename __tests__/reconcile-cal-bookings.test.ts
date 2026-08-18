import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { APPOINTMENT_STATUSES } from '../src/types/appointment-status.js';

vi.mock('../src/services/cal-com-tool-client.js', () => ({
    getBooking: vi.fn(),
}));

import { getBooking } from '../src/services/cal-com-tool-client.js';
import { reconcileCalBookingsHandler } from '../src/jobs/reconcile-cal-bookings.js';

function buildFakeFastify(): FastifyInstance {
    return { supabaseAdmin, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as FastifyInstance;
}

async function createAppointment(orgId: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const { data, error } = await supabaseAdmin
        .from('appointments')
        .insert({
            organization_id: orgId,
            customer_name: 'Prospecto Reconciliación',
            start_time: new Date(Date.now() + 86400000).toISOString(),
            end_time: new Date(Date.now() + 90000000).toISOString(),
            status: APPOINTMENT_STATUSES.CONFIRMADA,
            cal_booking_id: `cal_booking_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            ...overrides,
        })
        .select('id')
        .single();
    if (error || !data) throw new Error(`No se pudo crear la cita de prueba: ${error?.message}`);
    return data.id;
}

describe('src/jobs/reconcile-cal-bookings.ts — B.2', () => {
    let orgId: string;
    const createdAppointmentIds: string[] = [];

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org Pruebas reconcile-cal-bookings', email: `test-reconcile-${Date.now()}@example.invalid` })
            .select('id')
            .single();
        if (error || !data) throw new Error(`No se pudo crear la organización dedicada: ${error?.message}`);
        orgId = data.id;
    });

    afterAll(async () => {
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
    });

    afterEach(async () => {
        vi.mocked(getBooking).mockReset();
        // Limpia las citas de cada prueba de inmediato: dejarlas vivas hasta
        // afterAll hace que una cita "confirmada" de una prueba anterior
        // siga vigente (status programada/confirmada, cal_booking_id no
        // nulo) y contamine el query global de la siguiente prueba.
        if (createdAppointmentIds.length > 0) {
            const ids = createdAppointmentIds.splice(0);
            await supabaseAdmin.from('appointments').delete().in('id', ids);
        }
    });

    it('Cal.com reporta "cancelled" para una cita programada/confirmada → se actualiza a "cancelada"', async () => {
        const appointmentId = await createAppointment(orgId);
        createdAppointmentIds.push(appointmentId);
        vi.mocked(getBooking).mockResolvedValue({ calBookingId: 'irrelevante', status: 'cancelled' });

        await reconcileCalBookingsHandler(buildFakeFastify());

        const { data: after } = await supabaseAdmin.from('appointments').select('status, status_updated_by').eq('id', appointmentId).single();
        expect(after?.status).toBe(APPOINTMENT_STATUSES.CANCELADA);
        // Reconciliación automática, no un cambio manual: no hay usuario detrás.
        expect(after?.status_updated_by).toBeNull();
    });

    it('contraparte: Cal.com sigue reportando "accepted" → la cita no se toca', async () => {
        const appointmentId = await createAppointment(orgId);
        createdAppointmentIds.push(appointmentId);
        vi.mocked(getBooking).mockResolvedValue({ calBookingId: 'irrelevante', status: 'accepted' });

        await reconcileCalBookingsHandler(buildFakeFastify());

        const { data: after } = await supabaseAdmin.from('appointments').select('status').eq('id', appointmentId).single();
        expect(after?.status).toBe(APPOINTMENT_STATUSES.CONFIRMADA);
    });

    it('una cita sin cal_booking_id se ignora por completo (no se le llama a getBooking)', async () => {
        const appointmentId = await createAppointment(orgId, { cal_booking_id: null });
        createdAppointmentIds.push(appointmentId);

        await reconcileCalBookingsHandler(buildFakeFastify());

        // El job recorre TODAS las organizaciones con citas pendientes en la
        // base compartida de pruebas — se filtra por organizationId en vez
        // de asumir cero llamadas globales, para no acoplarse a datos de
        // otros suites.
        const callsForOurOrg = vi.mocked(getBooking).mock.calls.filter(([, organizationId]) => organizationId === orgId);
        expect(callsForOurOrg).toHaveLength(0);
    });

    it('un error consultando Cal.com para una cita no aborta la reconciliación del resto', async () => {
        const failingId = await createAppointment(orgId);
        const okId = await createAppointment(orgId);
        createdAppointmentIds.push(failingId, okId);

        vi.mocked(getBooking).mockImplementation(async (_fastify, _orgId, calBookingId) => {
            const { data } = await supabaseAdmin.from('appointments').select('id').eq('cal_booking_id', calBookingId).single();
            if (data?.id === failingId) throw new Error('Cal.com no responde');
            return { calBookingId, status: 'cancelled' };
        });

        await expect(reconcileCalBookingsHandler(buildFakeFastify())).resolves.not.toThrow();

        const { data: okAfter } = await supabaseAdmin.from('appointments').select('status').eq('id', okId).single();
        expect(okAfter?.status).toBe(APPOINTMENT_STATUSES.CANCELADA);
    });
});
