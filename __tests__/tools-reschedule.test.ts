import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { rescheduleToolRoute } from '../src/routes/tools/reschedule.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, getSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { APPOINTMENT_STATUSES } from '../src/types/appointment-status.js';

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
            status: APPOINTMENT_STATUSES.CONFIRMADA,
            ...overrides,
        })
        .select('id, start_time, end_time, customer_name, customer_email, customer_phone, cal_booking_id')
        .single();
    if (error || !data) throw new Error(`No se pudo crear la cita de prueba: ${error?.message}`);
    return data;
}

describe('POST /tools/:webhookToken/reschedule', () => {
    const TEST_WEBHOOK_TOKEN = `reschedule-test-token-${Date.now()}`;
    const createdAppointmentIds: string[] = [];
    let originalWebhookToken: string | null = null;
    let originalToolWebhookSecret: string | null = null;

    beforeAll(async () => {
        const { data: before } = await supabaseAdmin.from('organizations').select('webhook_token').eq('id', REAL_ORG_ID).maybeSingle();
        originalWebhookToken = before?.webhook_token ?? null;
        originalToolWebhookSecret = await getSecret(REAL_ORG_ID, SECRET_KEYS.TOOL_WEBHOOK_SECRET);

        const { error: orgErr } = await supabaseAdmin.from('organizations').update({ webhook_token: TEST_WEBHOOK_TOKEN }).eq('id', REAL_ORG_ID);
        if (orgErr) throw new Error(`No se pudo preparar webhook_token: ${orgErr.message}`);

        const saved = await setSecret(REAL_ORG_ID, SECRET_KEYS.TOOL_WEBHOOK_SECRET, TEST_TOOL_SECRET);
        if (!saved) throw new Error('No se pudo guardar tool_webhook_secret de prueba');
        clearSecretCache(REAL_ORG_ID);
    });

    afterAll(async () => {
        // Restaura el valor original en vez de hardcodear null/delete — esta
        // organización puede tener onboarding real de producción (ver
        // docs/tasks/elevenlabs-data-collection-key-mismatch.md).
        await supabaseAdmin.from('organizations').update({ webhook_token: originalWebhookToken }).eq('id', REAL_ORG_ID);
        if (originalToolWebhookSecret !== null) {
            await setSecret(REAL_ORG_ID, SECRET_KEYS.TOOL_WEBHOOK_SECRET, originalToolWebhookSecret);
        } else {
            await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', REAL_ORG_ID).eq('secret_key', SECRET_KEYS.TOOL_WEBHOOK_SECRET);
        }
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

    it('rechaza con 403 Forbidden cuando la organización está suspendida', async () => {
        await supabaseAdmin.from('organizations').update({ status: 'suspended', suspended_reason: 'Prueba de suspensión' }).eq('id', REAL_ORG_ID);
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/reschedule`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: 'X', customerEmail: 'x@example.invalid', newStartTime: '2026-09-10T10:00:00Z' },
            });
            expect(response.statusCode).toBe(403);
            expect(response.json().error).toBe('Forbidden');
            expect(vi.mocked(rescheduleBooking)).not.toHaveBeenCalled();
        } finally {
            await supabaseAdmin.from('organizations').update({ status: 'active', suspended_reason: null, suspended_at: null }).eq('id', REAL_ORG_ID);
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
        const appointment = await createAppointment({
            customer_name: 'María Pérez Reschedule',
            customer_email: 'maria-reschedule@example.invalid',
            cal_booking_id: 'cal_booking_old_email_1',
        });
        createdAppointmentIds.push(appointment.id);

        const newStartIso = '2026-09-15T15:00:00.000Z';
        const newCalBookingId = 'cal_booking_new_email_1';
        vi.mocked(rescheduleBooking).mockResolvedValue({ calBookingId: newCalBookingId, startTime: newStartIso, endTime: null });

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

            // 1. La cita original debe quedar marcada como CANCELADA (historial)
            const { data: original } = await supabaseAdmin.from('appointments').select('status').eq('id', appointment.id).single();
            expect(original?.status).toBe(APPOINTMENT_STATUSES.CANCELADA);

            // 2. Debe existir la nueva cita con el nuevo cal_booking_id y estado REPROGRAMADA
            const { data: newApp } = await supabaseAdmin
                .from('appointments')
                .select('id, start_time, status, end_time, cal_booking_id, customer_name, customer_email')
                .eq('organization_id', REAL_ORG_ID)
                .eq('cal_booking_id', newCalBookingId)
                .eq('status', APPOINTMENT_STATUSES.REPROGRAMADA)
                .single();

            expect(newApp).not.toBeNull();
            createdAppointmentIds.push(newApp!.id);
            expect(newApp?.customer_name).toBe(appointment.customer_name);
            expect(newApp?.customer_email).toBe(appointment.customer_email);
            expect(new Date(newApp!.start_time).toISOString()).toBe(newStartIso);
            expect(newApp?.end_time).not.toBeNull();
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

    it('sin teléfono ni correo: responde rescheduled=false pidiendo uno de los dos, sin consultar appointments', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/reschedule`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: 'Cliente Sin Contacto', newStartTime: '2026-09-11T10:00:00Z' },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.rescheduled).toBe(false);
            expect(body.message).toContain('teléfono');
            expect(vi.mocked(rescheduleBooking)).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('encuentra y reprograma una cita agendada solo con teléfono (sin correo, canal web chat), buscando por teléfono', async () => {
        const appointment = await createAppointment({
            customer_name: 'Cliente Solo Teléfono',
            customer_email: null,
            customer_phone: '+525588877766',
            cal_booking_id: 'cal_booking_old_phone_2',
        });
        createdAppointmentIds.push(appointment.id);

        const newStartIso = '2026-09-16T15:00:00.000Z';
        const newCalBookingId = 'cal_booking_new_phone_2';
        vi.mocked(rescheduleBooking).mockResolvedValue({ calBookingId: newCalBookingId, startTime: newStartIso, endTime: null });

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/reschedule`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                // Formato distinto al guardado (guardado en E.164): debe normalizar y emparejar igual.
                payload: { customerName: 'Cliente Solo Teléfono', customerPhone: '55 8887 7766', newStartTime: newStartIso },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.rescheduled).toBe(true);

            const { data: original } = await supabaseAdmin.from('appointments').select('status').eq('id', appointment.id).single();
            expect(original?.status).toBe(APPOINTMENT_STATUSES.CANCELADA);

            const { data: newApp } = await supabaseAdmin
                .from('appointments')
                .select('id, status, customer_phone')
                .eq('organization_id', REAL_ORG_ID)
                .eq('cal_booking_id', newCalBookingId)
                .eq('status', APPOINTMENT_STATUSES.REPROGRAMADA)
                .single();

            expect(newApp).not.toBeNull();
            createdAppointmentIds.push(newApp!.id);
            expect(newApp?.customer_phone).toBe(appointment.customer_phone);
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
            expect(unchanged?.status).toBe(APPOINTMENT_STATUSES.CONFIRMADA);
            expect(new Date(unchanged!.start_time).toISOString()).toBe(new Date(appointment.start_time).toISOString());
        } finally {
            await app.close();
        }
    });
});
