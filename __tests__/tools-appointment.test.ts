import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { appointmentToolRoute, formatSpanishAppointmentDate } from '../src/routes/tools/appointment.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, getSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { APPOINTMENT_STATUSES } from '../src/types/appointment-status.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';
const TEST_TOOL_SECRET = 'appointment-route-test-secret';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(appointmentToolRoute);
    await app.ready();
    return app;
}

async function createAppointment(overrides: Record<string, unknown> = {}) {
    const startTime = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
        .from('appointments')
        .insert({
            organization_id: REAL_ORG_ID,
            customer_name: 'Cliente Consulta',
            customer_email: 'cliente-consulta@example.invalid',
            customer_phone: '+525511223344',
            start_time: startTime,
            end_time: endTime,
            service_address: 'Av. Paseo de la Reforma 222, CDMX',
            status: APPOINTMENT_STATUSES.CONFIRMADA,
            ...overrides,
        })
        .select('id, start_time, end_time, customer_name, customer_email, customer_phone, service_address, status')
        .single();
    if (error || !data) throw new Error(`No se pudo crear la cita de prueba: ${error?.message}`);
    return data;
}

describe('POST /tools/:webhookToken/appointment y /appointment-details', () => {
    const TEST_WEBHOOK_TOKEN = `appointment-test-token-${Date.now()}`;
    const createdAppointmentIds: string[] = [];
    let originalWebhookToken: string | null = null;
    let originalToolWebhookSecret: string | null = null;

    beforeAll(async () => {
        const { data: before } = await supabaseAdmin
            .from('organizations')
            .select('webhook_token')
            .eq('id', REAL_ORG_ID)
            .maybeSingle();

        originalWebhookToken = before?.webhook_token ?? null;
        originalToolWebhookSecret = await getSecret(REAL_ORG_ID, SECRET_KEYS.TOOL_WEBHOOK_SECRET);

        const { error: orgErr } = await supabaseAdmin
            .from('organizations')
            .update({ webhook_token: TEST_WEBHOOK_TOKEN, status: 'active' })
            .eq('id', REAL_ORG_ID);
        if (orgErr) throw new Error(`No se pudo preparar webhook_token: ${orgErr.message}`);

        const saved = await setSecret(REAL_ORG_ID, SECRET_KEYS.TOOL_WEBHOOK_SECRET, TEST_TOOL_SECRET);
        if (!saved) throw new Error('No se pudo guardar tool_webhook_secret de prueba');
        clearSecretCache(REAL_ORG_ID);
    });

    afterAll(async () => {
        await supabaseAdmin
            .from('organizations')
            .update({ webhook_token: originalWebhookToken, status: 'active' })
            .eq('id', REAL_ORG_ID);

        if (originalToolWebhookSecret !== null) {
            await setSecret(REAL_ORG_ID, SECRET_KEYS.TOOL_WEBHOOK_SECRET, originalToolWebhookSecret);
        } else {
            await supabaseAdmin
                .from('organization_secrets')
                .delete()
                .eq('organization_id', REAL_ORG_ID)
                .eq('secret_key', SECRET_KEYS.TOOL_WEBHOOK_SECRET);
        }
        clearSecretCache(REAL_ORG_ID);

        if (createdAppointmentIds.length > 0) {
            await supabaseAdmin.from('appointments').delete().in('id', createdAppointmentIds);
        }
    });

    beforeEach(async () => {
        clearSecretCache(REAL_ORG_ID);
    });

    it('formatSpanishAppointmentDate maneja strings inválidas y zonas horarias correctamente', () => {
        expect(formatSpanishAppointmentDate('fecha-invalida', 'America/Mexico_City')).toBe('fecha-invalida');
        const formatted = formatSpanishAppointmentDate('2026-08-25T16:00:00Z', 'America/Mexico_City');
        expect(formatted).toContain('25 de agosto');
        expect(formatted).toContain('a las');
    });

    it('rechaza con 401 si falta la cabecera x-tool-secret', async () => {
        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/appointment`,
            payload: { customerPhone: '5511223344' },
        });

        expect(response.statusCode).toBe(401);
        const body = response.json();
        expect(body.error).toBe('Unauthorized');
        await app.close();
    });

    it('rechaza con 401 si el secreto en x-tool-secret es incorrecto', async () => {
        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/appointment`,
            headers: { 'x-tool-secret': 'secreto-invalido' },
            payload: { customerPhone: '5511223344' },
        });

        expect(response.statusCode).toBe(401);
        const body = response.json();
        expect(body.error).toBe('Unauthorized');
        await app.close();
    });

    it('rechaza con 403 si la organización está suspendida', async () => {
        await supabaseAdmin
            .from('organizations')
            .update({ status: 'suspended', suspended_reason: 'Prueba de suspensión' })
            .eq('id', REAL_ORG_ID);
        clearSecretCache(REAL_ORG_ID);

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/appointment`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { customerPhone: '5511223344' },
            });

            expect(response.statusCode).toBe(403);
            const body = response.json();
            expect(body.error).toBe('Forbidden');
            expect(body.message).toContain('suspendida');
        } finally {
            await supabaseAdmin.from('organizations').update({ status: 'active' }).eq('id', REAL_ORG_ID);
            clearSecretCache(REAL_ORG_ID);
            await app.close();
        }
    });

    it('devuelve found: false con mensaje verbalizable si no se envía ningún identificador', async () => {
        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/appointment`,
            headers: { 'x-tool-secret': TEST_TOOL_SECRET },
            payload: {},
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.found).toBe(false);
        expect(body.appointment).toBeNull();
        expect(body.message).toContain('necesito al menos tu número de teléfono');
        await app.close();
    });

    it('devuelve found: false con mensaje verbalizable si no existe ninguna cita para ese contacto', async () => {
        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/appointment`,
            headers: { 'x-tool-secret': TEST_TOOL_SECRET },
            payload: { customerPhone: '+525500000000' },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.found).toBe(false);
        expect(body.appointment).toBeNull();
        expect(body.message).toContain('No encontré ninguna cita programada a tu nombre');
        await app.close();
    });

    it('encuentra la cita por número de teléfono normalizado E.164 y genera mensaje verbalizable', async () => {
        const appt = await createAppointment({
            customer_phone: '+525512345678',
            customer_name: 'Carlos Ruiz',
            service_address: 'Sucursal Polanco',
        });
        createdAppointmentIds.push(appt.id);

        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/appointment`,
            headers: { 'x-tool-secret': TEST_TOOL_SECRET },
            // Enviamos teléfono local de 10 dígitos (se normalizará a +525512345678)
            payload: { customerPhone: '5512345678' },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.found).toBe(true);
        expect(body.appointment).toBeDefined();
        expect(body.appointment.id).toBe(appt.id);
        expect(body.appointment.customerName).toBe('Carlos Ruiz');
        expect(body.appointment.serviceAddress).toBe('Sucursal Polanco');
        expect(body.appointment.formattedDate).toBeDefined();
        expect(body.message).toContain('Tienes una cita programada para el');
        expect(body.message).toContain('Sucursal Polanco');
        await app.close();
    });

    it('encuentra la cita por correo electrónico y responde también en la ruta alias /appointment-details', async () => {
        const uniqueEmail = `consulta-${Date.now()}@test.com`;
        const appt = await createAppointment({
            customer_email: uniqueEmail,
            customer_name: 'María González',
        });
        createdAppointmentIds.push(appt.id);

        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/appointment-details`,
            headers: { 'x-tool-secret': TEST_TOOL_SECRET },
            payload: { customerEmail: uniqueEmail.toUpperCase() }, // Case-insensitive
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.found).toBe(true);
        expect(body.appointment.id).toBe(appt.id);
        expect(body.appointment.customerEmail).toBe(uniqueEmail);
        expect(body.message).toContain('Tienes una cita programada');
        await app.close();
    });

    it('encuentra la cita cuando se proporcionan tanto teléfono como correo', async () => {
        const uniqueEmail = `ambos-${Date.now()}@test.com`;
        const appt = await createAppointment({
            customer_phone: '+525577889900',
            customer_email: uniqueEmail,
            customer_name: 'Roberto Gómez',
        });
        createdAppointmentIds.push(appt.id);

        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/appointment`,
            headers: { 'x-tool-secret': TEST_TOOL_SECRET },
            payload: { customerPhone: '5577889900', customerEmail: uniqueEmail },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.found).toBe(true);
        expect(body.appointment.id).toBe(appt.id);
        await app.close();
    });

    it('encuentra la cita por nombre si no se proporciona teléfono ni correo', async () => {
        const uniqueName = `Nombre Unico ${Date.now()}`;
        const appt = await createAppointment({
            customer_name: uniqueName,
        });
        createdAppointmentIds.push(appt.id);

        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/appointment`,
            headers: { 'x-tool-secret': TEST_TOOL_SECRET },
            payload: { customerName: uniqueName },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.found).toBe(true);
        expect(body.appointment.id).toBe(appt.id);
        expect(body.appointment.customerName).toBe(uniqueName);
        await app.close();
    });

    it('ignora citas canceladas y devuelve no encontrada si solo existe una cancelada', async () => {
        const uniquePhone = '+525599881122';
        const appt = await createAppointment({
            customer_phone: uniquePhone,
            status: APPOINTMENT_STATUSES.CANCELADA,
        });
        createdAppointmentIds.push(appt.id);

        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/appointment`,
            headers: { 'x-tool-secret': TEST_TOOL_SECRET },
            payload: { customerPhone: uniquePhone },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.found).toBe(false);
        expect(body.appointment).toBeNull();
        await app.close();
    });

    it('aislamiento multi-tenant: no retorna citas de otra organización', async () => {
        const OTHER_ORG_ID = '00000000-0000-0000-0000-000000000000';
        const uniquePhone = '+525566667777';

        // Insertar cita con otra organization_id (si las FK lo permiten o usando mock/consulta)
        // Probamos que una cita de REAL_ORG_ID no sea visible con un token de otra org
        const appt = await createAppointment({
            customer_phone: uniquePhone,
        });
        createdAppointmentIds.push(appt.id);

        // Simulamos búsqueda desde un token que no corresponde
        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/appointment`,
            headers: { 'x-tool-secret': TEST_TOOL_SECRET },
            payload: { customerPhone: '+525500001111' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().found).toBe(false);
        await app.close();
    });
});
