import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { bookingToolRoute, invalidatePrimaryAddressCache } from '../src/routes/tools/booking.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, getSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';

vi.mock('../src/services/cal-com-tool-client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/services/cal-com-tool-client.js')>();
    return { ...actual, createBooking: vi.fn() };
});

import { createBooking, CalProviderError } from '../src/services/cal-com-tool-client.js';

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
    const createdContactEmails: string[] = [];
    const createdContactAddressIds: string[] = [];
    let orgId: string;

    beforeAll(async () => {
        const { data: org, error: orgErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org (tools-booking.test.ts)',
                email: `org-tools-booking-test-${Date.now()}@example.invalid`,
                webhook_token: TEST_WEBHOOK_TOKEN,
                cal_event_type_id: 12345,
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
        for (const conversationId of createdConversationIds) {
            await supabaseAdmin.from('appointments').delete().eq('conversation_id', conversationId);
        }
        // contact_addresses antes que contacts (FK): appointments.contact_address_id
        // ya quedó libre al borrar las citas de arriba.
        for (const addressId of createdContactAddressIds) {
            await supabaseAdmin.from('contact_addresses').delete().eq('id', addressId);
        }
        for (const phone of createdContactPhones) {
            await supabaseAdmin.from('contacts').delete().eq('organization_id', orgId).eq('phone_e164', phone);
        }
        for (const email of createdContactEmails) {
            await supabaseAdmin.from('contacts').delete().eq('organization_id', orgId).eq('email', email);
        }
        await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', orgId);
        clearSecretCache(orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
    });

    beforeEach(() => {
        vi.mocked(createBooking).mockReset();
        invalidatePrimaryAddressCache();
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
        await supabaseAdmin.from('organizations').update({ status: 'suspended', suspended_reason: 'Prueba de suspensión' }).eq('id', orgId);
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
            await supabaseAdmin.from('organizations').update({ status: 'active', suspended_reason: null, suspended_at: null }).eq('id', orgId);
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
            expect(appointment?.organization_id).toBe(orgId);
            expect(appointment?.cal_booking_id).toBe('cal_booking_test_1');
            expect(appointment?.contact_id).toBeTruthy();

            const { data: contact } = await supabaseAdmin
                .from('contacts')
                .select('id, phone_e164')
                .eq('organization_id', orgId)
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

    it('contraparte de éxito: web chat sin teléfono agenda solo con correo, resuelve contact_id por correo (resolve_contact)', async () => {
        const conversationId = `booking-test:${Date.now()}:email-only`;
        createdConversationIds.push(conversationId);
        const email = `webchat-sin-telefono-${Date.now()}@example.invalid`;
        createdContactEmails.push(email);

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
                payload: { conversationId, customerName: 'Cliente Web Chat Sin Teléfono', customerEmail: email, startTime: '2026-09-05T10:00:00Z' },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.booked).toBe(true);

            const { data: appointment } = await supabaseAdmin
                .from('appointments')
                .select('contact_id, customer_phone, customer_email')
                .eq('conversation_id', conversationId)
                .single();
            // Fase B/C: resolve_contact ahora resuelve/crea contacto también
            // solo por correo — antes de esto quedaba en null.
            expect(appointment?.contact_id).toBeTruthy();
            expect(appointment?.customer_phone).toBeNull();
            expect(appointment?.customer_email).toBe(email);

            const { data: contact } = await supabaseAdmin.from('contacts').select('email, phone_e164').eq('id', appointment!.contact_id).single();
            expect(contact?.email).toBe(email);
            expect(contact?.phone_e164).toBeNull();

            expect(vi.mocked(createBooking)).toHaveBeenCalledWith(
                expect.anything(),
                orgId,
                expect.objectContaining({ customerPhone: null, customerEmail: email }),
                expect.anything()
            );
        } finally {
            await app.close();
        }
    });

    it('Fase C — sin contactAddressId/serviceAddress y el contacto ya tiene dirección principal: la propone en la respuesta, sin asignarla a la cita', async () => {
        const conversationId = `booking-test:${Date.now()}:propose-address`;
        createdConversationIds.push(conversationId);
        const phone = `55${Math.floor(Math.random() * 90000000 + 10000000)}`;
        const phoneE164 = `+52${phone}`;
        createdContactPhones.push(phoneE164);

        const { data: contactId } = await supabaseAdmin.rpc('resolve_contact', { p_org_id: orgId, p_phone: phoneE164, p_email: null });
        const { data: addressId } = await supabaseAdmin.rpc('resolve_contact_address', {
            p_org_id: orgId,
            p_contact_id: contactId,
            p_street: 'Av. Ya Registrada 200',
            p_city: 'CDMX',
        });
        createdContactAddressIds.push(addressId as string);

        vi.mocked(createBooking).mockResolvedValue({
            calBookingId: 'cal_booking_test_propose_address',
            startTime: '2026-09-06T10:00:00.000Z',
            endTime: '2026-09-06T10:30:00.000Z',
        });

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/booking`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { conversationId, customerName: 'Cliente Con Dirección Previa', customerPhone: phone, startTime: '2026-09-06T10:00:00Z' },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.booked).toBe(true);
            expect(body.proposedAddress).toMatchObject({ addressId, street: 'Av. Ya Registrada 200', city: 'CDMX' });

            const { data: appointment } = await supabaseAdmin
                .from('appointments')
                .select('contact_address_id, service_address')
                .eq('conversation_id', conversationId)
                .single();
            // Proponer no es asignar: la cita no queda con dirección hasta que se confirme explícitamente.
            expect(appointment?.contact_address_id).toBeNull();
            expect(appointment?.service_address).toBeNull();
        } finally {
            await app.close();
        }
    });

    it('Fase C — serviceAddress nuevo se consolida en contact_addresses y la cita guarda contact_address_id + instantánea de texto', async () => {
        const conversationId = `booking-test:${Date.now()}:new-address`;
        createdConversationIds.push(conversationId);
        const phone = `55${Math.floor(Math.random() * 90000000 + 10000000)}`;
        createdContactPhones.push(`+52${phone}`);

        vi.mocked(createBooking).mockResolvedValue({
            calBookingId: 'cal_booking_test_new_address',
            startTime: '2026-09-07T10:00:00.000Z',
            endTime: '2026-09-07T10:30:00.000Z',
        });

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/booking`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: {
                    conversationId,
                    customerName: 'Cliente Dirección Nueva',
                    customerPhone: phone,
                    startTime: '2026-09-07T10:00:00Z',
                    serviceAddress: 'Calle Nueva Dictada 300',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json().booked).toBe(true);

            const { data: appointment } = await supabaseAdmin
                .from('appointments')
                .select('contact_address_id, service_address')
                .eq('conversation_id', conversationId)
                .single();
            expect(appointment?.contact_address_id).toBeTruthy();
            expect(appointment?.service_address).toBe('Calle Nueva Dictada 300');
            createdContactAddressIds.push(appointment!.contact_address_id as string);

            const { data: addressRow } = await supabaseAdmin.from('contact_addresses').select('street, address_type').eq('id', appointment!.contact_address_id).single();
            expect(addressRow?.street).toBe('Calle Nueva Dictada 300');
            expect(addressRow?.address_type).toBe('domicilio');
        } finally {
            await app.close();
        }
    });

    it('Fase C — contactAddressId ya confirmado por el agente se usa directamente, sin volver a pedir la dirección', async () => {
        const conversationId = `booking-test:${Date.now()}:confirmed-address`;
        createdConversationIds.push(conversationId);
        const phone = `55${Math.floor(Math.random() * 90000000 + 10000000)}`;
        const phoneE164 = `+52${phone}`;
        createdContactPhones.push(phoneE164);

        const { data: contactId } = await supabaseAdmin.rpc('resolve_contact', { p_org_id: orgId, p_phone: phoneE164, p_email: null });
        const { data: addressId } = await supabaseAdmin.rpc('resolve_contact_address', {
            p_org_id: orgId,
            p_contact_id: contactId,
            p_street: 'Av. Confirmada Por El Cliente 400',
        });
        createdContactAddressIds.push(addressId as string);

        vi.mocked(createBooking).mockResolvedValue({
            calBookingId: 'cal_booking_test_confirmed_address',
            startTime: '2026-09-08T10:00:00.000Z',
            endTime: '2026-09-08T10:30:00.000Z',
        });

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/booking`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { conversationId, customerName: 'Cliente Confirma Dirección', customerPhone: phone, startTime: '2026-09-08T10:00:00Z', contactAddressId: addressId },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json().booked).toBe(true);

            const { data: appointment } = await supabaseAdmin
                .from('appointments')
                .select('contact_address_id, service_address')
                .eq('conversation_id', conversationId)
                .single();
            expect(appointment?.contact_address_id).toBe(addressId);
            expect(appointment?.service_address).toBe('Av. Confirmada Por El Cliente 400');
        } finally {
            await app.close();
        }
    });

    it('Fase C — contraparte de rechazo: un contactAddressId que no pertenece al contacto se ignora sin bloquear la cita', async () => {
        const conversationId = `booking-test:${Date.now()}:foreign-address`;
        createdConversationIds.push(conversationId);
        const phone = `55${Math.floor(Math.random() * 90000000 + 10000000)}`;
        createdContactPhones.push(`+52${phone}`);

        vi.mocked(createBooking).mockResolvedValue({
            calBookingId: 'cal_booking_test_foreign_address',
            startTime: '2026-09-09T10:00:00.000Z',
            endTime: '2026-09-09T10:30:00.000Z',
        });

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/booking`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: {
                    conversationId,
                    customerName: 'Cliente Dirección Ajena',
                    customerPhone: phone,
                    startTime: '2026-09-09T10:00:00Z',
                    contactAddressId: '00000000-0000-0000-0000-000000000000',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json().booked).toBe(true);

            const { data: appointment } = await supabaseAdmin
                .from('appointments')
                .select('contact_address_id')
                .eq('conversation_id', conversationId)
                .single();
            expect(appointment?.contact_address_id).toBeNull();
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
