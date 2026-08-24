import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { cancelToolRoute } from '../src/routes/tools/cancel.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, getSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { APPOINTMENT_STATUSES } from '../src/types/appointment-status.js';

vi.mock('../src/services/cal-com-tool-client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/services/cal-com-tool-client.js')>();
    return { ...actual, cancelBooking: vi.fn() };
});

import { cancelBooking, CalProviderError } from '../src/services/cal-com-tool-client.js';

const TEST_TOOL_SECRET = 'cancel-route-test-secret';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(cancelToolRoute);
    await app.ready();
    return app;
}

describe('POST /tools/:webhookToken/cancel', () => {
    const TEST_WEBHOOK_TOKEN = `cancel-test-token-${Date.now()}`;
    const createdAppointmentIds: string[] = [];
    let orgId: string;

    async function createAppointment(overrides: Record<string, unknown> = {}) {
        const startTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const endTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString();
        const { data, error } = await supabaseAdmin
            .from('appointments')
            .insert({
                organization_id: orgId,
                customer_name: 'Cliente Cancel',
                customer_email: 'cliente-cancel@example.invalid',
                customer_phone: '+525599998888',
                start_time: startTime,
                end_time: endTime,
                cal_booking_id: 'cal_booking_cancel_base',
                status: APPOINTMENT_STATUSES.CONFIRMADA,
                ...overrides,
            })
            .select('id, start_time, end_time')
            .single();
        if (error || !data) throw new Error(`No se pudo crear la cita de prueba: ${error?.message}`);
        return data;
    }

    beforeAll(async () => {
        const { data: org, error: orgErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org (tools-cancel.test.ts)',
                email: `org-tools-cancel-test-${Date.now()}@example.invalid`,
                webhook_token: TEST_WEBHOOK_TOKEN,
                cal_event_type_id: 12345,
                status: 'active',
            })
            .select('id')
            .single();
        if (orgErr || !org) throw new Error(`No se pudo crear la organización de prueba: ${orgErr?.message}`);
        orgId = org.id;

        const saved = await setSecret(orgId, SECRET_KEYS.TOOL_WEBHOOK_SECRET, TEST_TOOL_SECRET);
        if (!saved) throw new Error('No se pudo guardar tool_webhook_secret de prueba');
        clearSecretCache(orgId);
    });

    afterAll(async () => {
        if (createdAppointmentIds.length > 0) {
            await supabaseAdmin.from('appointments').delete().in('id', createdAppointmentIds);
        }
        await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', orgId);
        clearSecretCache(orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
    });

    beforeEach(() => {
        vi.mocked(cancelBooking).mockReset();
    });

    it('rechaza con 401 cuando el webhookToken no resuelve a ninguna organización', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/tools/token-inexistente/cancel',
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: 'X', customerEmail: 'x@example.invalid' },
            });
            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('rechaza con 403 Forbidden cuando la organización está suspendida', async () => {
        await supabaseAdmin.from('organizations').update({ status: 'suspended', suspended_reason: 'Prueba de suspensión' }).eq('id', orgId);
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/cancel`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: 'X', customerEmail: 'x@example.invalid' },
            });
            expect(response.statusCode).toBe(403);
            expect(response.json().error).toBe('Forbidden');
            expect(vi.mocked(cancelBooking)).not.toHaveBeenCalled();
        } finally {
            await supabaseAdmin.from('organizations').update({ status: 'active', suspended_reason: null, suspended_at: null }).eq('id', orgId);
            await app.close();
        }
    });

    it('cita inexistente: nombre/correo que no coinciden responde 200 con cancelled=false y mensaje verbalizable', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/cancel`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: 'Nadie Existe Con Este Nombre', customerEmail: 'nadie-existe@example.invalid' },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.cancelled).toBe(false);
            expect(body.message).toContain('No encontré una cita');
            expect(vi.mocked(cancelBooking)).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: nombre y correo coinciden, cancela en Cal.com y en Supabase', async () => {
        const appointment = await createAppointment({ customer_name: 'María Cancel Éxito', customer_email: 'maria-cancel@example.invalid' });
        createdAppointmentIds.push(appointment.id);

        vi.mocked(cancelBooking).mockResolvedValue(undefined);

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/cancel`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: '  María Cancel Éxito  ', customerEmail: 'MARIA-CANCEL@example.invalid' },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.cancelled).toBe(true);
            expect(body.message).toContain('cancelada correctamente');

            expect(vi.mocked(cancelBooking)).toHaveBeenCalledOnce();

            const { data: updated } = await supabaseAdmin.from('appointments').select('status').eq('id', appointment.id).single();
            expect(updated?.status).toBe(APPOINTMENT_STATUSES.CANCELADA);
        } finally {
            await app.close();
        }
    });

    it('éxito con teléfono: cancela buscando por nombre y teléfono normalizado', async () => {
        const appointment = await createAppointment({
            customer_name: 'Cliente Solo Teléfono Cancel',
            customer_email: null,
            customer_phone: '+525577766655',
        });
        createdAppointmentIds.push(appointment.id);

        vi.mocked(cancelBooking).mockResolvedValue(undefined);

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/cancel`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                // Formato distinto al guardado (guardado en E.164): debe normalizar y emparejar igual.
                payload: { customerName: 'Cliente Solo Teléfono Cancel', customerPhone: '55 7776 6655' },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.cancelled).toBe(true);

            const { data: updated } = await supabaseAdmin.from('appointments').select('status').eq('id', appointment.id).single();
            expect(updated?.status).toBe(APPOINTMENT_STATUSES.CANCELADA);
        } finally {
            await app.close();
        }
    });

    it('sin teléfono ni correo: responde cancelled=false pidiendo uno de los dos', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/cancel`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: 'Cliente Sin Contacto' },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.cancelled).toBe(false);
            expect(body.message).toContain('teléfono');
            expect(vi.mocked(cancelBooking)).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('aislamiento multi-tenant: una cita de otra organización no se encuentra aunque nombre y correo coincidan', async () => {
        const { data: otherOrg } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org B Cancel Isolation', email: `org-b-cancel-${Date.now()}@example.invalid` })
            .select('id')
            .single();

        const appointment = await createAppointment({
            organization_id: otherOrg!.id,
            customer_name: 'Cliente De Otra Org Cancel',
            customer_email: 'cliente-otra-org-cancel@example.invalid',
        });

        try {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/tools/${TEST_WEBHOOK_TOKEN}/cancel`,
                    headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                    payload: { customerName: 'Cliente De Otra Org Cancel', customerEmail: 'cliente-otra-org-cancel@example.invalid' },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.cancelled).toBe(false);
                expect(vi.mocked(cancelBooking)).not.toHaveBeenCalled();
            } finally {
                await app.close();
            }
        } finally {
            await supabaseAdmin.from('appointments').delete().eq('id', appointment.id);
            await supabaseAdmin.from('organizations').delete().eq('id', otherOrg!.id);
        }
    });

    it('Cal.com falla: marca cancelada localmente de todas formas (best-effort) y registra warning', async () => {
        const appointment = await createAppointment({ customer_name: 'Cliente Cal Falla', customer_email: 'cal-falla-cancel@example.invalid' });
        createdAppointmentIds.push(appointment.id);

        vi.mocked(cancelBooking).mockRejectedValue(new CalProviderError(500, 'Cal.com caído'));

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/cancel`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: 'Cliente Cal Falla', customerEmail: 'cal-falla-cancel@example.invalid' },
            });
            expect(response.statusCode).toBe(200);
            // A pesar de que Cal.com falló, se cancela localmente.
            expect(response.json().cancelled).toBe(true);

            const { data: updated } = await supabaseAdmin.from('appointments').select('status').eq('id', appointment.id).single();
            expect(updated?.status).toBe(APPOINTMENT_STATUSES.CANCELADA);
        } finally {
            await app.close();
        }
    });

    it('cita sin cal_booking_id: cancela solo en Supabase sin llamar a Cal.com', async () => {
        const appointment = await createAppointment({
            customer_name: 'Cliente Sin Cal Id Cancel',
            customer_email: 'sin-cal-id-cancel@example.invalid',
            cal_booking_id: null,
        });
        createdAppointmentIds.push(appointment.id);

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/cancel`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: 'Cliente Sin Cal Id Cancel', customerEmail: 'sin-cal-id-cancel@example.invalid' },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().cancelled).toBe(true);
            expect(vi.mocked(cancelBooking)).not.toHaveBeenCalled();

            const { data: updated } = await supabaseAdmin.from('appointments').select('status').eq('id', appointment.id).single();
            expect(updated?.status).toBe(APPOINTMENT_STATUSES.CANCELADA);
        } finally {
            await app.close();
        }
    });

    it('cita ya cancelada: no la encuentra porque el filtro excluye canceladas', async () => {
        const appointment = await createAppointment({
            customer_name: 'Cliente Ya Cancelado',
            customer_email: 'ya-cancelado@example.invalid',
            status: APPOINTMENT_STATUSES.CANCELADA,
        });
        createdAppointmentIds.push(appointment.id);

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/cancel`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: 'Cliente Ya Cancelado', customerEmail: 'ya-cancelado@example.invalid' },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.cancelled).toBe(false);
            expect(body.message).toContain('No encontré una cita');
            expect(vi.mocked(cancelBooking)).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });
});
