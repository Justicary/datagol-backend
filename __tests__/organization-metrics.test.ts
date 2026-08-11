import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationMetricsRoutes from '../src/routes/organization-metrics.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(organizationMetricsRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
}

// Mismo patrón que __tests__/contacts.test.ts: JWT real vía
// signInWithPassword, no simulado.
async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-metrics-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createErr || !created.user) throw new Error(`No se pudo crear el usuario de prueba: ${createErr?.message}`);

    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) throw new Error(`No se pudo iniciar sesión de prueba: ${signInErr?.message}`);

    return { userId: created.user.id, jwt: session.session.access_token };
}

async function deleteTestUser(userId: string): Promise<void> {
    await supabaseAdmin.auth.admin.deleteUser(userId);
}

describe('GET /api/organizations/:id/metrics', () => {
    let owner: TestUser;
    let outsider: TestUser;
    let orgId: string;
    let sharedContactId: string;

    const PERIOD_FROM = '2026-06-01T00:00:00.000Z';
    const PERIOD_TO = '2026-06-30T00:00:00.000Z';
    const IN_PERIOD = '2026-06-15T12:00:00.000Z';
    const OUTSIDE_PERIOD = '2026-01-01T00:00:00.000Z'; // antes del periodo, a propósito

    const CONV_VOICE_1 = `metrics-test-voice-1-${Date.now()}`;
    const CONV_VOICE_2 = `metrics-test-voice-2-${Date.now()}`;
    const CONV_WA_1 = `metrics-test-wa-1-${Date.now()}`;
    const CONV_ORPHAN = `metrics-test-orphan-${Date.now()}`;
    const CONV_OUTSIDE = `metrics-test-outside-${Date.now()}`;

    const allConversationIds = [CONV_VOICE_1, CONV_VOICE_2, CONV_WA_1, CONV_ORPHAN, CONV_OUTSIDE];

    beforeAll(async () => {
        owner = await createTestUserWithJwt();
        outsider = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Metrics Test Org',
            p_email: `metrics-test-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`Setup falló creando organización: ${error?.message}`);
        orgId = org.id;

        const { data: contact, error: contactErr } = await supabaseAdmin
            .from('contacts')
            .insert({ organization_id: orgId, phone_e164: '+525511122233', full_name: 'Contacto Cross Canal' })
            .select('id')
            .single();
        if (contactErr || !contact) throw new Error(`Setup falló creando contacto: ${contactErr?.message}`);
        sharedContactId = contact.id;

        // voice-1: dentro del periodo, capturado (nombre), caliente, con cita — vinculado al contacto cross-canal.
        await supabaseAdmin.from('leads').insert({
            organization_id: orgId,
            contact_id: sharedContactId,
            channel: 'voice',
            conversation_id: CONV_VOICE_1,
            full_name: 'Cliente Voz Uno',
            temperature: 'caliente',
            booked_appointment: true,
            created_at: IN_PERIOD,
        });

        // voice-2: dentro del periodo, SIN nombre/correo/teléfono — no cuenta como "capturado".
        await supabaseAdmin.from('leads').insert({
            organization_id: orgId,
            channel: 'voice',
            conversation_id: CONV_VOICE_2,
            temperature: 'frio',
            booked_appointment: false,
            created_at: IN_PERIOD,
        });

        // whatsapp-1: dentro del periodo, capturado, ni caliente ni con cita.
        await supabaseAdmin.from('leads').insert({
            organization_id: orgId,
            channel: 'whatsapp',
            conversation_id: CONV_WA_1,
            full_name: 'Cliente WhatsApp Uno',
            temperature: 'tibio',
            booked_appointment: false,
            created_at: IN_PERIOD,
        });

        // Lead FUERA del periodo, mismo contacto que voice-1 pero canal distinto:
        // crossChannelContacts debe seguir contándolo (histórico, no acotado al periodo),
        // mientras que las métricas por canal del periodo consultado deben ignorarlo.
        await supabaseAdmin.from('leads').insert({
            organization_id: orgId,
            contact_id: sharedContactId,
            channel: 'whatsapp',
            conversation_id: CONV_OUTSIDE,
            full_name: 'Cliente Fuera De Periodo',
            created_at: OUTSIDE_PERIOD,
        });

        // usage_events de voice-1: agent_minute + tokens LLM de DOS modelos distintos
        // (deben colapsar en una sola categoría 'llm_tokens' en la salida).
        // amount_usd es una columna GENERADA (quantity * unit_rate_usd) —
        // nunca se inserta explícitamente, Postgres la rechaza (428C9).
        // quantity/unit_rate_usd están elegidos para que el producto dé
        // exactamente los montos usados en las aserciones de abajo.
        const { error: usageInsertError } = await supabaseAdmin.from('usage_events').insert([
            { organization_id: orgId, provider: 'elevenlabs', unit_type: 'agent_minute', quantity: 2, unit_rate_usd: 1, conversation_id: CONV_VOICE_1, occurred_at: IN_PERIOD },
            { organization_id: orgId, provider: 'elevenlabs', unit_type: 'llm_input_token_gemini-2.5-flash', quantity: 100, unit_rate_usd: 0.005, conversation_id: CONV_VOICE_1, occurred_at: IN_PERIOD },
            { organization_id: orgId, provider: 'elevenlabs', unit_type: 'llm_output_token_gpt-4o', quantity: 10, unit_rate_usd: 0.03, conversation_id: CONV_VOICE_1, occurred_at: IN_PERIOD },
            // voice-2: un solo asiento de agent_minute.
            { organization_id: orgId, provider: 'elevenlabs', unit_type: 'agent_minute', quantity: 1, unit_rate_usd: 1, conversation_id: CONV_VOICE_2, occurred_at: IN_PERIOD },
            // whatsapp-1: un mensaje.
            { organization_id: orgId, provider: 'meta', unit_type: 'wa_message', quantity: 1, unit_rate_usd: 0.1, conversation_id: CONV_WA_1, occurred_at: IN_PERIOD },
            // Huérfano: conversation_id que no corresponde a ningún lead de esta organización.
            { organization_id: orgId, provider: 'elevenlabs', unit_type: 'agent_minute', quantity: 5, unit_rate_usd: 1, conversation_id: CONV_ORPHAN, occurred_at: IN_PERIOD },
        ]);
        if (usageInsertError) throw new Error(`Setup falló creando usage_events: ${usageInsertError.message}`);
    });

    afterAll(async () => {
        await supabaseAdmin.from('usage_events').delete().in('conversation_id', allConversationIds);
        await supabaseAdmin.from('leads').delete().in('conversation_id', allConversationIds);
        await supabaseAdmin.from('contacts').delete().eq('id', sharedContactId);
        await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await deleteTestUser(owner.userId);
        await deleteTestUser(outsider.userId);
    });

    it('sin JWT → 401', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({ method: 'GET', url: `/api/organizations/${orgId}/metrics?from=${PERIOD_FROM}&to=${PERIOD_TO}` });
            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('con JWT válido pero sin membresía en la organización → 403', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/metrics?from=${PERIOD_FROM}&to=${PERIOD_TO}`,
                headers: { authorization: `Bearer ${outsider.jwt}` },
            });
            expect(response.statusCode).toBe(403);
        } finally {
            await app.close();
        }
    });

    it('parámetro de ruta "id" no es UUID → 400', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/api/organizations/no-es-un-uuid/metrics?from=${PERIOD_FROM}&to=${PERIOD_TO}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('faltan "from"/"to" → 400', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/metrics`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('"from"/"to" no son fechas ISO válidas → 400', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/metrics?from=no-es-fecha&to=tampoco`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('"from" no es anterior a "to" → 400', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/metrics?from=${PERIOD_TO}&to=${PERIOD_FROM}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: agrega por canal, atribuye costo por conversation_id, agrupa tokens LLM y expone consumo huérfano', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/metrics?from=${PERIOD_FROM}&to=${PERIOD_TO}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();

            expect(body.organizationId).toBe(orgId);
            expect(body.crossChannelContacts).toBe(1);
            // La organización no tiene tipoCambioUSD configurado: nunca se inventa una tasa.
            expect(body.exchangeRateUsed).toBeNull();

            const voice = body.channels.find((c: any) => c.channel === 'voice');
            expect(voice).toBeTruthy();
            expect(voice.conversationsTotal).toBe(2);
            expect(voice.leadsCaptured).toBe(1);
            expect(voice.hotLeads).toBe(1);
            expect(voice.appointmentsBooked).toBe(1);
            expect(voice.costUsd).toBeCloseTo(3.8, 6);
            expect(voice.costMxn).toBeNull();
            expect(voice.costPerLeadCapturedUsd).toBeCloseTo(3.8, 6);
            expect(voice.costPerAppointmentUsd).toBeCloseTo(3.8, 6);
            expect(voice.appointmentConversionRate).toBeCloseTo(0.5, 6);

            const voiceAgentMinute = voice.costByCategory.find((c: any) => c.category === 'agent_minute');
            const voiceLlmTokens = voice.costByCategory.find((c: any) => c.category === 'llm_tokens');
            expect(voiceAgentMinute.costUsd).toBeCloseTo(3.0, 6);
            // Dos unit_type distintos (gemini y gpt-4o, input y output) colapsados en una sola fila.
            expect(voiceLlmTokens.costUsd).toBeCloseTo(0.8, 6);
            expect(voice.costByCategory.filter((c: any) => c.category === 'llm_tokens')).toHaveLength(1);

            const whatsapp = body.channels.find((c: any) => c.channel === 'whatsapp');
            expect(whatsapp).toBeTruthy();
            // El lead FUERA de periodo (mismo contacto, canal whatsapp) no debe contarse aquí.
            expect(whatsapp.conversationsTotal).toBe(1);
            expect(whatsapp.leadsCaptured).toBe(1);
            expect(whatsapp.hotLeads).toBe(0);
            expect(whatsapp.appointmentsBooked).toBe(0);
            expect(whatsapp.costUsd).toBeCloseTo(0.1, 6);
            // Denominador 0: costo por cita es indefinido, no cero.
            expect(whatsapp.costPerAppointmentUsd).toBeNull();
            expect(whatsapp.appointmentConversionRate).toBe(0);

            expect(body.unattributedUsage.entriesCount).toBe(1);
            expect(body.unattributedUsage.costUsd).toBeCloseTo(5.0, 6);
            expect(body.unattributedUsage.costByCategory).toEqual([{ category: 'agent_minute', costUsd: 5, costMxn: null }]);
        } finally {
            await app.close();
        }
    });

    it('con tipoCambioUSD configurado, convierte los totales a MXN sin alterar los USD', async () => {
        const { error: updateErr } = await supabaseAdmin
            .from('organizations')
            .update({ integration_settings: { tipoCambioUSD: 18.5 } })
            .eq('id', orgId);
        expect(updateErr).toBeNull();

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/metrics?from=${PERIOD_FROM}&to=${PERIOD_TO}`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();

            expect(body.exchangeRateUsed).toBeCloseTo(18.5, 6);
            const voice = body.channels.find((c: any) => c.channel === 'voice');
            expect(voice.costUsd).toBeCloseTo(3.8, 6);
            expect(voice.costMxn).toBeCloseTo(3.8 * 18.5, 4);
            expect(body.unattributedUsage.costMxn).toBeCloseTo(5.0 * 18.5, 4);
        } finally {
            await app.close();
        }
    });
});
