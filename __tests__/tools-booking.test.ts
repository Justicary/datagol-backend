import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { bookingToolRoute } from '../src/routes/tools/booking.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, getSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';

vi.mock('../src/services/cal-com-tool-client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/services/cal-com-tool-client.js')>();
    return { ...actual, createBooking: vi.fn() };
});

import { createBooking, CalProviderError } from '../src/services/cal-com-tool-client.js';

// Organización real existente (ver __tests__/entitlements.test.ts). Ya tiene
// cal_event_type_id configurado en producción.
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';
const TEST_TOOL_SECRET = 'booking-route-test-secret';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(bookingToolRoute);
    await app.ready();
    return app;
}

describe('POST /tools/:webhookToken/booking', () => {
    const TEST_WEBHOOK_TOKEN = `booking-test-token-${Date.now()}`;
    const createdConversationIds: string[] = [];
    const createdContactPhones: string[] = [];
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

        for (const conversationId of createdConversationIds) {
            await supabaseAdmin.from('appointments').delete().eq('conversation_id', conversationId);
        }
        for (const phone of createdContactPhones) {
            await supabaseAdmin.from('contacts').delete().eq('organization_id', REAL_ORG_ID).eq('phone_e164', phone);
        }
    });

    beforeEach(() => {
        vi.mocked(createBooking).mockReset();
    });

    it('rechaza con 401 cuando el webhookToken no resuelve a ninguna organización', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/tools/token-inexistente/booking',
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { conversationId: 'conv_x', customerName: 'X', customerPhone: '+525599999999', startTime: '2026-09-01T10:00:00Z' },
            });
            expect(response.statusCode).toBe(401);
            expect(vi.mocked(createBooking)).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('rechaza con 400 cuando falta conversationId (requerido para idempotencia)', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/booking`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerName: 'X', customerPhone: '+525599999999', startTime: '2026-09-01T10:00:00Z' },
            });
            expect(response.statusCode).toBe(400);
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
                url: `/tools/${TEST_WEBHOOK_TOKEN}/booking`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { conversationId: `booking-test:${Date.now()}:suspended`, customerName: 'X', customerPhone: '+525599999999', startTime: '2026-09-01T10:00:00Z' },
            });
            expect(response.statusCode).toBe(403);
            expect(response.json().error).toBe('Forbidden');
            expect(vi.mocked(createBooking)).not.toHaveBeenCalled();
        } finally {
            await supabaseAdmin.from('organizations').update({ status: 'active', suspended_reason: null, suspended_at: null }).eq('id', REAL_ORG_ID);
            await app.close();
        }
    });

    it('contraparte de éxito: crea la cita, resuelve contact_id por teléfono normalizado y responde booked=true', async () => {
        const conversationId = `booking-test:${Date.now()}:success`;
        createdConversationIds.push(conversationId);
        const phone = '5599988877';
        createdContactPhones.push('+525599988877');

        vi.mocked(createBooking).mockResolvedValue({
            calBookingId: 'cal_booking_test_1',
            startTime: '2026-09-01T10:00:00.000Z',
            endTime: '2026-09-01T10:30:00.000Z',
        });

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/booking`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: {
                    conversationId,
                    customerName: 'Cliente de Prueba Booking',
                    customerPhone: phone,
                    customerEmail: 'cliente-booking@example.invalid',
                    startTime: '2026-09-01T10:00:00Z',
                },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.booked).toBe(true);
            expect(body.appointmentId).toBeTruthy();

            const { data: appointment } = await supabaseAdmin
                .from('appointments')
                .select('organization_id, conversation_id, contact_id, cal_booking_id')
                .eq('conversation_id', conversationId)
                .single();
            expect(appointment?.organization_id).toBe(REAL_ORG_ID);
            expect(appointment?.cal_booking_id).toBe('cal_booking_test_1');
            expect(appointment?.contact_id).toBeTruthy();

            const { data: contact } = await supabaseAdmin
                .from('contacts')
                .select('id, phone_e164')
                .eq('organization_id', REAL_ORG_ID)
                .eq('phone_e164', '+525599988877')
                .single();
            expect(contact?.id).toBe(appointment?.contact_id);
        } finally {
            await app.close();
        }
    });

    it('idempotencia: un reintento con el mismo conversationId no crea una segunda cita ni vuelve a llamar a Cal.com', async () => {
        const conversationId = `booking-test:${Date.now()}:idempotent`;
        createdConversationIds.push(conversationId);

        vi.mocked(createBooking).mockResolvedValue({
            calBookingId: 'cal_booking_test_2',
            startTime: '2026-09-02T10:00:00.000Z',
            endTime: '2026-09-02T10:30:00.000Z',
        });

        const app = await buildTestApp();
        try {
            const firstResponse = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/booking`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { conversationId, customerName: 'Cliente Idempotente', customerPhone: 'no-es-un-telefono-valido', startTime: '2026-09-02T10:00:00Z' },
            });
            expect(firstResponse.statusCode).toBe(200);
            expect(firstResponse.json().booked).toBe(true);
            expect(vi.mocked(createBooking)).toHaveBeenCalledTimes(1);

            const secondResponse = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/booking`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { conversationId, customerName: 'Cliente Idempotente', customerPhone: 'no-es-un-telefono-valido', startTime: '2026-09-02T10:00:00Z' },
            });
            expect(secondResponse.statusCode).toBe(200);
            expect(secondResponse.json().booked).toBe(true);
            // No se volvió a invocar Cal.com: la segunda llamada se resolvió por idempotencia.
            expect(vi.mocked(createBooking)).toHaveBeenCalledTimes(1);

            const { data: rows } = await supabaseAdmin.from('appointments').select('id').eq('conversation_id', conversationId);
            expect(rows).toHaveLength(1);
        } finally {
            await app.close();
        }
    });

    it('teléfono no normalizable: la cita se crea igual, sin contact_id (no aborta el booking, AGENTS.md §1.3)', async () => {
        const conversationId = `booking-test:${Date.now()}:bad-phone`;
        createdConversationIds.push(conversationId);

        vi.mocked(createBooking).mockResolvedValue({
            calBookingId: 'cal_booking_test_3',
            startTime: '2026-09-03T10:00:00.000Z',
            endTime: null,
        });

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/booking`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { conversationId, customerName: 'Cliente Sin Telefono Valido', customerPhone: 'abc', startTime: '2026-09-03T10:00:00Z' },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json().booked).toBe(true);

            const { data: appointment } = await supabaseAdmin.from('appointments').select('contact_id').eq('conversation_id', conversationId).single();
            expect(appointment?.contact_id).toBeNull();
        } finally {
            await app.close();
        }
    });

    it('sin teléfono ni correo: responde booked=false pidiendo uno de los dos, sin llamar a Cal.com', async () => {
        const conversationId = `booking-test:${Date.now()}:no-contact`;
        createdConversationIds.push(conversationId);

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/booking`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { conversationId, customerName: 'Cliente Sin Contacto', startTime: '2026-09-04T10:00:00Z' },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.booked).toBe(false);
            expect(body.message).toContain('teléfono');
            expect(vi.mocked(createBooking)).not.toHaveBeenCalled();

            const { data: rows } = await supabaseAdmin.from('appointments').select('id').eq('conversation_id', conversationId);
            expect(rows).toHaveLength(0);
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: web chat sin teléfono agenda solo con correo, sin contact_id', async () => {
        const conversationId = `booking-test:${Date.now()}:email-only`;
        createdConversationIds.push(conversationId);

        vi.mocked(createBooking).mockResolvedValue({
            calBookingId: 'cal_booking_test_email_only',
            startTime: '2026-09-05T10:00:00.000Z',
            endTime: '2026-09-05T10:30:00.000Z',
        });

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/booking`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { conversationId, customerName: 'Cliente Web Chat Sin Teléfono', customerEmail: 'webchat-sin-telefono@example.invalid', startTime: '2026-09-05T10:00:00Z' },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.booked).toBe(true);

            const { data: appointment } = await supabaseAdmin
                .from('appointments')
                .select('contact_id, customer_phone, customer_email')
                .eq('conversation_id', conversationId)
                .single();
            expect(appointment?.contact_id).toBeNull();
            expect(appointment?.customer_phone).toBeNull();
            expect(appointment?.customer_email).toBe('webchat-sin-telefono@example.invalid');

            expect(vi.mocked(createBooking)).toHaveBeenCalledWith(
                expect.anything(),
                REAL_ORG_ID,
                expect.objectContaining({ customerPhone: null, customerEmail: 'webchat-sin-telefono@example.invalid' }),
                expect.anything()
            );
        } finally {
            await app.close();
        }
    });

    it('degradación: si Cal.com falla, responde 200 con booked=false y un mensaje verbalizable en vez de un 500', async () => {
        const conversationId = `booking-test:${Date.now()}:degraded`;
        createdConversationIds.push(conversationId);

        vi.mocked(createBooking).mockRejectedValue(new CalProviderError(500, 'Cal.com caído'));

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/booking`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { conversationId, customerName: 'X', customerPhone: '+525599999999', startTime: '2026-09-01T10:00:00Z' },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.booked).toBe(false);
            expect(typeof body.message).toBe('string');

            const { data: rows } = await supabaseAdmin.from('appointments').select('id').eq('conversation_id', conversationId);
            expect(rows).toHaveLength(0);
        } finally {
            await app.close();
        }
    });
});
