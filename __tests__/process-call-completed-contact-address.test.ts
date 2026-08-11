import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { processCallCompletedHandler, type ProcessCallCompletedJobData } from '../src/jobs/process-call-completed.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

function buildPayload(dataCollectionResults: Record<string, unknown>, conversationId: string, phone: string | null) {
    return {
        type: 'post_call_transcription',
        event_timestamp: 1700000000,
        data: {
            agent_id: 'agent_test',
            conversation_id: conversationId,
            transcript: [{ role: 'user', message: 'Hola' }],
            analysis: { transcript_summary: 'Resumen de prueba.', data_collection_results: dataCollectionResults },
            metadata: {
                call_duration_secs: 60,
                phone_call: phone ? { external_number: phone, direction: 'inbound' } : null,
            },
        },
    };
}

async function insertWebhookEvent(conversationId: string, dataCollectionResults: Record<string, unknown>, phone: string | null): Promise<string> {
    const { data, error } = await supabaseAdmin
        .from('webhook_events')
        .insert({
            organization_id: REAL_ORG_ID,
            provider: 'elevenlabs',
            event_id: `contact-address-test:${conversationId}`,
            event_type: 'post_call_transcription',
            raw_payload: buildPayload(dataCollectionResults, conversationId, phone),
        })
        .select('id')
        .single();
    if (error || !data) throw new Error(`No se pudo crear webhook_events de prueba: ${error?.message}`);
    return data.id;
}

function buildFakeFastify() {
    const fastify = {
        supabaseAdmin,
        pgBoss: { send: vi.fn().mockResolvedValue('fake-pgboss-job-id') },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as FastifyInstance & { pgBoss: { send: ReturnType<typeof vi.fn> } };
    return fastify;
}

function buildJob(webhookEventId: string): Job<ProcessCallCompletedJobData> {
    return { id: 'fake-job-id', data: { webhookEventId } } as unknown as Job<ProcessCallCompletedJobData>;
}

/**
 * Fase B (docs/tasks/opus.md) — cuando el payload de ElevenLabs trae
 * dirección capturada por el agente (`direccion_prospecto` en Data
 * Collection), debe consolidarse en `contact_addresses` vía
 * `resolve_contact_address`, no morir solo en `call_logs`.
 *
 * Nota: verificado contra los últimos 15 webhook_events reales de
 * producción que el agente de ElevenLabs NO tiene estos campos configurados
 * hoy — este test usa un payload construido a mano (misma forma real de
 * `data_collection_results`) para ejercitar la ruta de código de todos
 * modos, dejándola lista para cuando se configure.
 */
describe('process-call-completed: consolidación de dirección en contact_addresses (Fase B)', () => {
    const createdConversationIds: string[] = [];

    afterEach(async () => {
        for (const conversationId of createdConversationIds) {
            await supabaseAdmin.from('contact_addresses').delete().eq('organization_id', REAL_ORG_ID).in('street', ['Av. Reforma 500', 'Calle Sin Dirección 1']);
            await supabaseAdmin.from('leads').delete().eq('conversation_id', conversationId);
            await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', conversationId);
            await supabaseAdmin.from('webhook_events').delete().eq('event_id', `contact-address-test:${conversationId}`);
        }
        createdConversationIds.length = 0;
    });

    it('contraparte de éxito: payload con dirección capturada crea/vincula una fila en contact_addresses', async () => {
        const conversationId = `contact-address-test:${Date.now()}:con-direccion`;
        createdConversationIds.push(conversationId);
        const phone = `+5255${Math.floor(Math.random() * 90000000 + 10000000)}`;

        const webhookEventId = await insertWebhookEvent(
            conversationId,
            {
                nombre_completo_prospecto: { value: 'Cliente Con Dirección' },
                direccion_prospecto: { value: 'Av. Reforma 500' },
                ciudad_prospecto: { value: 'CDMX' },
                estado_prospecto: { value: 'CDMX' },
                cp_prospecto: { value: '06600' },
            },
            phone
        );

        const fastify = buildFakeFastify();
        await processCallCompletedHandler(fastify, buildJob(webhookEventId));

        const { data: contact } = await supabaseAdmin.from('contacts').select('id').eq('organization_id', REAL_ORG_ID).eq('phone_e164', phone).maybeSingle();
        expect(contact).toBeTruthy();

        const { data: address } = await supabaseAdmin
            .from('contact_addresses')
            .select('street, city, state, postal_code, address_type, is_primary')
            .eq('contact_id', contact!.id)
            .maybeSingle();

        expect(address?.street).toBe('Av. Reforma 500');
        expect(address?.city).toBe('CDMX');
        expect(address?.postal_code).toBe('06600');
        expect(address?.address_type).toBe('servicio');
        expect(address?.is_primary).toBe(true);

        await supabaseAdmin.from('contacts').delete().eq('id', contact!.id);
    });

    it('sin dirección en el payload (caso real actual): no crea ninguna fila en contact_addresses, no falla el job', async () => {
        const conversationId = `contact-address-test:${Date.now()}:sin-direccion`;
        createdConversationIds.push(conversationId);
        const phone = `+5255${Math.floor(Math.random() * 90000000 + 10000000)}`;

        const webhookEventId = await insertWebhookEvent(
            conversationId,
            { nombre_completo_prospecto: { value: 'Cliente Sin Dirección' } },
            phone
        );

        const fastify = buildFakeFastify();
        await expect(processCallCompletedHandler(fastify, buildJob(webhookEventId))).resolves.not.toThrow();

        const { data: contact } = await supabaseAdmin.from('contacts').select('id').eq('organization_id', REAL_ORG_ID).eq('phone_e164', phone).maybeSingle();
        expect(contact).toBeTruthy();

        const { data: addresses } = await supabaseAdmin.from('contact_addresses').select('id').eq('contact_id', contact!.id);
        expect(addresses).toHaveLength(0);

        await supabaseAdmin.from('contacts').delete().eq('id', contact!.id);
    });
});
