import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify from 'fastify';
import crypto from 'crypto';
import supabasePlugin from '../src/plugins/supabase.js';
import { elevenLabsPostCallWebhookRoutes } from '../src/routes/webhooks/elevenlabs.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(elevenLabsPostCallWebhookRoutes);
    await app.ready();
    return app;
}

describe('2.1 — POST /webhooks/elevenlabs/:webhookToken', () => {
    // Requiere db/migrations/04_organizations_webhook_token.sql aplicada
    // (columna organizations.webhook_token).
    const TEST_WEBHOOK_TOKEN = `test-token-${crypto.randomUUID()}`;

    beforeAll(async () => {
        const { error } = await supabaseAdmin
            .from('organizations')
            .update({ webhook_token: TEST_WEBHOOK_TOKEN })
            .eq('id', REAL_ORG_ID);
        // Falla explícita (no silenciosa) si falta aplicar
        // db/migrations/04_organizations_webhook_token.sql: sin esto, "org no
        // encontrada" y "org encontrada sin secreto" son indistinguibles (ambas
        // dan 401), y las pruebas de abajo pasarían por la razón equivocada.
        if (error) {
            throw new Error(`No se pudo preparar organizations.webhook_token para la prueba: ${error.message}`);
        }
    });

    afterAll(async () => {
        await supabaseAdmin.from('organizations').update({ webhook_token: null }).eq('id', REAL_ORG_ID);
    });

    it('rechaza con 401 cuando el webhookToken de la ruta no resuelve a ninguna organización', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/webhooks/elevenlabs/token-inexistente-xyz',
                payload: { type: 'post_call_transcription', data: { conversation_id: 'conv_x' } },
            });
            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('resuelve la organización por el token de la ruta ANTES de necesitar campos del cuerpo, y aun así rechaza sin webhook_signing_secret configurado', async () => {
        const app = await buildTestApp();
        try {
            // El cuerpo ni siquiera trae agent_id: la resolución de tenant no depende de él.
            const response = await app.inject({
                method: 'POST',
                url: `/webhooks/elevenlabs/${TEST_WEBHOOK_TOKEN}`,
                payload: { type: 'post_call_transcription', data: { conversation_id: 'conv_x' } },
            });
            expect(response.statusCode).toBe(401);
            const body = response.json();
            expect(body.error).toBe('Unauthorized');
        } finally {
            await app.close();
        }
    });
});

describe('2.1 — Idempotencia de entrega en webhook_events', () => {
    const TEST_EVENT_ID = `test:idempotencia:${Date.now()}`;

    afterEach(async () => {
        await supabaseAdmin.from('webhook_events').delete().eq('event_id', TEST_EVENT_ID);
    });

    it('el mismo (provider, event_id) entregado dos veces no produce dos filas', async () => {
        const first = await supabaseAdmin
            .from('webhook_events')
            .insert({
                organization_id: REAL_ORG_ID,
                provider: 'elevenlabs',
                event_id: TEST_EVENT_ID,
                event_type: 'post_call_transcription',
                raw_payload: { test: true },
            })
            .select('id')
            .single();

        expect(first.error).toBeNull();

        const second = await supabaseAdmin
            .from('webhook_events')
            .insert({
                organization_id: REAL_ORG_ID,
                provider: 'elevenlabs',
                event_id: TEST_EVENT_ID,
                event_type: 'post_call_transcription',
                raw_payload: { test: true },
            })
            .select('id')
            .single();

        // webhook_events_provider_event_id_key: UNIQUE (provider, event_id), ya existente en el esquema.
        expect(second.error).not.toBeNull();
        expect(second.error?.code).toBe('23505');

        const { data: rows } = await supabaseAdmin
            .from('webhook_events')
            .select('id')
            .eq('event_id', TEST_EVENT_ID);

        expect(rows?.length).toBe(1);
    });
});
