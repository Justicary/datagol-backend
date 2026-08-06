import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { processCallCompletedHandler, type ProcessCallCompletedJobData } from '../src/jobs/process-call-completed.js';
import { NOTIFY_HOT_LEAD_QUEUE } from '../src/jobs/notify-hot-lead.js';
import { SEND_CALL_SUMMARY_QUEUE } from '../src/jobs/send-call-summary.js';
import { SEND_PROSPECT_SUMMARY_QUEUE } from '../src/jobs/send-prospect-summary.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

function buildPayload(dataCollectionResults: Record<string, unknown>, conversationId: string) {
    return {
        type: 'post_call_transcription',
        event_timestamp: 1700000000,
        data: {
            agent_id: 'agent_test',
            conversation_id: conversationId,
            transcript: [{ role: 'user', message: 'Hola' }],
            analysis: {
                transcript_summary: 'Resumen de prueba.',
                data_collection_results: dataCollectionResults,
            },
            metadata: { call_duration_secs: 120 },
        },
    };
}

async function insertWebhookEvent(conversationId: string, dataCollectionResults: Record<string, unknown>): Promise<string> {
    const { data, error } = await supabaseAdmin
        .from('webhook_events')
        .insert({
            organization_id: REAL_ORG_ID,
            provider: 'elevenlabs',
            event_id: `notif-trigger-test:${conversationId}`,
            event_type: 'post_call_transcription',
            raw_payload: buildPayload(dataCollectionResults, conversationId),
        })
        .select('id')
        .single();

    if (error || !data) {
        throw new Error(`No se pudo crear webhook_events de prueba: ${error?.message}`);
    }
    return data.id;
}

function buildFakeFastify() {
    const sendSpy = vi.fn().mockResolvedValue('fake-pgboss-job-id');
    const fastify = {
        supabaseAdmin,
        pgBoss: { send: sendSpy },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as FastifyInstance & { pgBoss: { send: typeof sendSpy } };
    return { fastify, sendSpy };
}

function buildJob(webhookEventId: string): Job<ProcessCallCompletedJobData> {
    return { id: 'fake-job-id', data: { webhookEventId } } as unknown as Job<ProcessCallCompletedJobData>;
}

describe('2.2/4 — process-call-completed: condiciones de disparo de las notificaciones', () => {
    const createdConversationIds: string[] = [];

    afterEach(async () => {
        for (const conversationId of createdConversationIds) {
            await supabaseAdmin.from('leads').delete().eq('conversation_id', conversationId);
            await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', conversationId);
            await supabaseAdmin.from('webhook_events').delete().eq('event_id', `notif-trigger-test:${conversationId}`);
        }
        createdConversationIds.length = 0;
    });

    it('caliente + sin cita + requiere_seguimiento: encola las tres notificaciones (notify-hot-lead con prioridad alta)', async () => {
        const conversationId = `notif-trigger:${Date.now()}:full`;
        createdConversationIds.push(conversationId);

        const webhookEventId = await insertWebhookEvent(conversationId, {
            temperatura: { value: 'caliente' },
            agendo_cita: { value: false },
            requiere_seguimiento: { value: true },
            email: { value: 'prospecto@example.invalid' },
        });

        const { fastify, sendSpy } = buildFakeFastify();
        await processCallCompletedHandler(fastify, buildJob(webhookEventId));

        const queueNames = sendSpy.mock.calls.map((call) => call[0]);
        expect(queueNames).toContain(SEND_CALL_SUMMARY_QUEUE);
        expect(queueNames).toContain(NOTIFY_HOT_LEAD_QUEUE);
        expect(queueNames).toContain(SEND_PROSPECT_SUMMARY_QUEUE);

        const hotLeadCall = sendSpy.mock.calls.find((call) => call[0] === NOTIFY_HOT_LEAD_QUEUE);
        expect(hotLeadCall?.[2]).toMatchObject({ priority: 10 });
    });

    it('caliente pero YA agendó cita: NO encola notify-hot-lead (contraparte de rechazo del caso anterior)', async () => {
        const conversationId = `notif-trigger:${Date.now()}:booked`;
        createdConversationIds.push(conversationId);

        const webhookEventId = await insertWebhookEvent(conversationId, {
            temperatura: { value: 'caliente' },
            agendo_cita: { value: true },
        });

        const { fastify, sendSpy } = buildFakeFastify();
        await processCallCompletedHandler(fastify, buildJob(webhookEventId));

        const queueNames = sendSpy.mock.calls.map((call) => call[0]);
        expect(queueNames).toContain(SEND_CALL_SUMMARY_QUEUE);
        expect(queueNames).not.toContain(NOTIFY_HOT_LEAD_QUEUE);
    });

    it('temperatura no caliente: NO encola notify-hot-lead', async () => {
        const conversationId = `notif-trigger:${Date.now()}:frio`;
        createdConversationIds.push(conversationId);

        const webhookEventId = await insertWebhookEvent(conversationId, {
            temperatura: { value: 'frio' },
            agendo_cita: { value: false },
        });

        const { fastify, sendSpy } = buildFakeFastify();
        await processCallCompletedHandler(fastify, buildJob(webhookEventId));

        const queueNames = sendSpy.mock.calls.map((call) => call[0]);
        expect(queueNames).not.toContain(NOTIFY_HOT_LEAD_QUEUE);
    });

    it('sin requiere_seguimiento: NO encola send-prospect-summary, pero sí la minuta general', async () => {
        const conversationId = `notif-trigger:${Date.now()}:sin-seguimiento`;
        createdConversationIds.push(conversationId);

        const webhookEventId = await insertWebhookEvent(conversationId, {
            temperatura: { value: 'tibio' },
            requiere_seguimiento: { value: false },
        });

        const { fastify, sendSpy } = buildFakeFastify();
        await processCallCompletedHandler(fastify, buildJob(webhookEventId));

        const queueNames = sendSpy.mock.calls.map((call) => call[0]);
        expect(queueNames).toContain(SEND_CALL_SUMMARY_QUEUE);
        expect(queueNames).not.toContain(SEND_PROSPECT_SUMMARY_QUEUE);
    });
});
