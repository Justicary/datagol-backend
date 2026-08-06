import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { rescheduleToolRoute } from '../src/routes/tools/reschedule.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';

vi.mock('../src/services/cal-com-tool-client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/services/cal-com-tool-client.js')>();
    return { ...actual, rescheduleBooking: vi.fn() };
});

import { rescheduleBooking, CalProviderError } from '../src/services/cal-com-tool-client.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';
const TEST_TOOL_SECRET = 'reschedule-route-test-secret';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(rescheduleToolRoute);
    await app.ready();
    return app;
}

async function createAppointment(overrides: Record<string, unknown> = {}) {
    const startTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
        .from('appointments')
        .insert({
            organization_id: REAL_ORG_ID,
            customer_name: 'Cliente Reschedule',
            customer_email: 'cliente-reschedule@example.invalid',
            customer_phone: '+525599999999',
            start_time: startTime,
            end_time: endTime,
            cal_booking_id: 'cal_booking_reschedule_base',
            status: 'confirmed',
            ...overrides,
        })
        .select('id, start_time, end_time')
        .single();
    if (error || !data) throw new Error(`No se pudo crear la cita de prueba: ${error?.message}`);
    return data;
}

describe('POST /tools/:webhookToken/reschedule', () => {
    const TEST_WEBHOOK_TOKEN = `reschedule-test-token-${Date.now()}`;
    const createdAppointmentIds: string[] = [];

    beforeAll(async () => {
        const { error: orgErr } = await supabaseAdmin.from('organizations').update({ webhook_token: TEST_WEBHOOK_TOKEN }).eq('id', REAL_ORG_ID);
        if (orgErr) throw new Error(`No se pudo preparar webhook_token: ${orgErr.message}`);

        const saved = await setSecret(REAL_ORG_ID, SECRET_KEYS.TOOL_WEBHOOK_SECRET, TEST_TOOL_SECRET);
        if (!saved) throw new Error('No se pudo guardar tool_webhook_secret de prueba');
        clearSecretCache(REAL_ORG_ID);
    });

    afterAll(async () => {
        await supabaseAdmin.from('organizations').update({ webhook_token: null }).eq('id', REAL_ORG_ID);
        await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', REAL_ORG_ID).eq('secret_key', SECRET_KEYS.TOOL_WEBHOOK_SECRET);
        clearSecretCache(REAL_ORG_ID);

        if (createdAppointmentIds.length > 0) {
            await supabaseAdmin.from('appointments').delete().in('id', createdAppointmentIds);
        }
    });

    beforeEach(() => {
        vi.mocked(rescheduleBooking).mockReset();
    });

    it('rechaza con 401 cuando el webhookToken no resuelve a ninguna organización', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/tools/token-inexistente/reschedule',
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: 'X', customerEmail: 'x@example.invalid', newStartTime: '2026-09-10T10:00:00Z' },
            });
            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('cita inexistente: nombre/correo que no coinciden con ninguna cita futura responde 200 con mensaje verbalizable, sin llamar a Cal.com', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/reschedule`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: 'Nadie Existe Con Este Nombre', customerEmail: 'nadie-existe@example.invalid', newStartTime: '2026-09-10T10:00:00Z' },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.rescheduled).toBe(false);
            expect(body.message).toContain('No encontré una cita');
            expect(vi.mocked(rescheduleBooking)).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: nombre y correo coinciden con una cita futura y la reprograma', async () => {
        const appointment = await createAppointment({ customer_name: 'María Pérez Reschedule', customer_email: 'maria-reschedule@example.invalid' });
        createdAppointmentIds.push(appointment.id);

        const newStartIso = '2026-09-15T15:00:00.000Z';
        vi.mocked(rescheduleBooking).mockResolvedValue({ calBookingId: 'cal_booking_reschedule_base', startTime: newStartIso, endTime: null });

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/reschedule`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                // Correo en distinto case y espacios extra: debe emparejar de todas formas.
                payload: { customerName: '  María Pérez Reschedule  ', customerEmail: 'MARIA-RESCHEDULE@example.invalid', newStartTime: newStartIso },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.rescheduled).toBe(true);
            expect(body.newStartTime).toBe(newStartIso);

            const { data: updated } = await supabaseAdmin.from('appointments').select('start_time, status, end_time').eq('id', appointment.id).single();
            expect(updated?.status).toBe('rescheduled');
            expect(new Date(updated!.start_time).toISOString()).toBe(newStartIso);
            // end_time NOT NULL preservado con la duración original (30 min) ya que Cal.com no devolvió `end`.
            expect(updated?.end_time).not.toBeNull();
        } finally {
            await app.close();
        }
    });

    it('aislamiento multi-tenant: una cita de otra organización no se encuentra aunque nombre y correo coincidan', async () => {
        const { data: otherOrg } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org B Reschedule Isolation', email: `org-b-reschedule-${Date.now()}@example.invalid` })
            .select('id')
            .single();

        const appointment = await createAppointment({
            organization_id: otherOrg!.id,
            customer_name: 'Cliente De Otra Org',
            customer_email: 'cliente-otra-org@example.invalid',
        });

        try {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/tools/${TEST_WEBHOOK_TOKEN}/reschedule`,
                    headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                    payload: { customerName: 'Cliente De Otra Org', customerEmail: 'cliente-otra-org@example.invalid', newStartTime: '2026-09-20T10:00:00Z' },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.rescheduled).toBe(false);
                expect(vi.mocked(rescheduleBooking)).not.toHaveBeenCalled();
            } finally {
                await app.close();
            }
        } finally {
            await supabaseAdmin.from('appointments').delete().eq('id', appointment.id);
            await supabaseAdmin.from('organizations').delete().eq('id', otherOrg!.id);
        }
    });

    it('cita sin cal_booking_id: responde degradado sin intentar llamar a Cal.com', async () => {
        const appointment = await createAppointment({
            customer_name: 'Cliente Sin CalBookingId',
            customer_email: 'sin-cal-booking-id@example.invalid',
            cal_booking_id: null,
        });
        createdAppointmentIds.push(appointment.id);

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/reschedule`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: 'Cliente Sin CalBookingId', customerEmail: 'sin-cal-booking-id@example.invalid', newStartTime: '2026-09-21T10:00:00Z' },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().rescheduled).toBe(false);
            expect(vi.mocked(rescheduleBooking)).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('degradación: si Cal.com falla, responde 200 con rescheduled=false sin haber modificado la cita', async () => {
        const appointment = await createAppointment({ customer_name: 'Cliente Degradado', customer_email: 'cliente-degradado@example.invalid' });
        createdAppointmentIds.push(appointment.id);

        vi.mocked(rescheduleBooking).mockRejectedValue(new CalProviderError(500, 'Cal.com caído'));

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/reschedule`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: 'Cliente Degradado', customerEmail: 'cliente-degradado@example.invalid', newStartTime: '2026-09-22T10:00:00Z' },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().rescheduled).toBe(false);

            const { data: unchanged } = await supabaseAdmin.from('appointments').select('status, start_time').eq('id', appointment.id).single();
            expect(unchanged?.status).toBe('confirmed');
            expect(new Date(unchanged!.start_time).toISOString()).toBe(new Date(appointment.start_time).toISOString());
        } finally {
            await app.close();
        }
    });
});
