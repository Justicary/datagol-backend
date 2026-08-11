import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { processCallCompletedHandler, type ProcessCallCompletedJobData } from '../src/jobs/process-call-completed.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

/**
 * `normalizePhoneE164` valida contra el plan de numeración real (libphonenumber),
 * no solo la forma — un sufijo arbitrario de 10 dígitos después de "+52" puede
 * no ser un número mexicano válido y normalizePhoneE164 lo rechaza (a
 * diferencia de __tests__/process-call-completed-rpc.test.ts, que llama al
 * RPC directo con p_caller_phone_e164 ya armado, sin pasar por esta
 * validación). El LADA 55 (CDMX) con cualquier suscriptor de 8 dígitos sí es
 * válido — verificado directamente contra normalizePhoneE164, no asumido.
 */
function randomMxPhone(): string {
    const subscriber = Math.floor(10_000_000 + Math.random() * 89_999_999);
    return `+5255${subscriber}`;
}

/**
 * Respaldo de `whatsapp_messages` por turno (ver comentario en
 * jobs/process-call-completed.ts): ElevenLabs no expone webhook por mensaje
 * individual, Meta le entrega los webhooks de WhatsApp directo a ElevenLabs,
 * nunca a este backend — así que esto solo puede pasar al terminar la
 * conversación, en el mismo webhook post-llamada que ya procesamos.
 */
function buildWhatsappPayload(
    conversationId: string,
    phone: string,
    transcript: Array<{ role: string; message: string | null }>
) {
    return {
        type: 'post_call_transcription',
        event_timestamp: 1700000000,
        data: {
            agent_id: 'agent_test',
            conversation_id: conversationId,
            transcript,
            analysis: { transcript_summary: 'Resumen de prueba WhatsApp.' },
            metadata: {
                call_duration_secs: 60,
                conversation_initiation_source: 'whatsapp',
                text_only: true,
                phone_call: null,
                // whatsapp_user_id trae el "1" histórico de trunk móvil de
                // México antes de los 10 dígitos (mismo formato real
                // verificado en process-call-completed-rpc.test.ts:
                // '5212213528341' → normaliza a '+522213528341'). `phone` es
                // '+52' + 10 dígitos, así que el user_id es '521' + esos
                // mismos 10 dígitos.
                whatsapp: { whatsapp_user_id: `521${phone.slice(3)}` },
            },
        },
    };
}

function buildVoicePayload(conversationId: string, phone: string) {
    return {
        type: 'post_call_transcription',
        event_timestamp: 1700000000,
        data: {
            agent_id: 'agent_test',
            conversation_id: conversationId,
            transcript: [{ role: 'user', message: 'Hola, hablo por teléfono' }],
            analysis: { transcript_summary: 'Resumen de prueba voz.' },
            metadata: { call_duration_secs: 60, phone_call: { external_number: phone } },
        },
    };
}

async function insertWebhookEvent(organizationId: string, conversationId: string, payload: unknown): Promise<string> {
    const { data, error } = await supabaseAdmin
        .from('webhook_events')
        .insert({
            organization_id: organizationId,
            provider: 'elevenlabs',
            event_id: `whatsapp-messages-test:${conversationId}`,
            event_type: 'post_call_transcription',
            raw_payload: payload,
        })
        .select('id')
        .single();

    if (error || !data) {
        throw new Error(`No se pudo crear webhook_events de prueba: ${error?.message}`);
    }
    return data.id;
}

function buildFakeFastify(): FastifyInstance {
    return {
        supabaseAdmin,
        pgBoss: { send: async () => 'fake-pgboss-job-id' },
        log: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as FastifyInstance;
}

function buildJob(webhookEventId: string): Job<ProcessCallCompletedJobData> {
    return { id: 'fake-job-id', data: { webhookEventId } } as unknown as Job<ProcessCallCompletedJobData>;
}

describe('process-call-completed: respaldo de whatsapp_messages por turno', () => {
    const createdConversationIds: string[] = [];
    const createdPhones: string[] = [];

    afterEach(async () => {
        for (const phone of createdPhones) {
            const { data: contact } = await supabaseAdmin
                .from('contacts')
                .select('id')
                .eq('organization_id', REAL_ORG_ID)
                .eq('phone_e164', phone)
                .maybeSingle();
            if (contact?.id) {
                // whatsapp_messages.contact_id no tiene ON DELETE CASCADE: hay
                // que borrar los mensajes antes que el contacto, o el DELETE
                // del contacto falla por la FK.
                await supabaseAdmin.from('whatsapp_messages').delete().eq('contact_id', contact.id);
            }
            await supabaseAdmin.from('contacts').delete().eq('phone_e164', phone);
        }
        for (const conversationId of createdConversationIds) {
            await supabaseAdmin.from('leads').delete().eq('conversation_id', conversationId);
            await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', conversationId);
            await supabaseAdmin.from('webhook_events').delete().eq('event_id', `whatsapp-messages-test:${conversationId}`);
        }
        createdConversationIds.length = 0;
        createdPhones.length = 0;
    });

    it('conversación de WhatsApp: inserta un mensaje por turno, con la dirección correcta y sin los turnos vacíos', async () => {
        const conversationId = `whatsapp-messages-test:${Date.now()}:full`;
        const phone = randomMxPhone();
        createdConversationIds.push(conversationId);
        createdPhones.push(phone);

        const webhookEventId = await insertWebhookEvent(
            REAL_ORG_ID,
            conversationId,
            buildWhatsappPayload(conversationId, phone, [
                { role: 'agent', message: 'Hola, ¿en qué puedo ayudarte?' },
                { role: 'user', message: 'Quiero cotizar un servicio.' },
                { role: 'agent', message: '' }, // turno vacío: no debe generar fila
                { role: 'agent', message: null }, // idem
            ])
        );

        await processCallCompletedHandler(buildFakeFastify(), buildJob(webhookEventId));

        const { data: contact } = await supabaseAdmin
            .from('contacts')
            .select('id')
            .eq('organization_id', REAL_ORG_ID)
            .eq('phone_e164', phone)
            .single();

        const { data: messages } = await supabaseAdmin
            .from('whatsapp_messages')
            .select('direction, body, wa_message_id, sent_by_user_id')
            .eq('contact_id', contact!.id)
            .order('wa_message_id', { ascending: true });

        expect(messages).toHaveLength(2);
        expect(messages?.[0]).toMatchObject({ direction: 'outbound', body: 'Hola, ¿en qué puedo ayudarte?', sent_by_user_id: null });
        expect(messages?.[1]).toMatchObject({ direction: 'inbound', body: 'Quiero cotizar un servicio.', sent_by_user_id: null });
        expect(messages?.every((m) => m.wa_message_id?.startsWith(`backfill:${conversationId}:`))).toBe(true);
    });

    it('idempotencia: reprocesar el mismo webhook (processed_at reseteado, simulando un reintento de pg-boss) no duplica los mensajes', async () => {
        const conversationId = `whatsapp-messages-test:${Date.now()}:retry`;
        const phone = randomMxPhone();
        createdConversationIds.push(conversationId);
        createdPhones.push(phone);

        const webhookEventId = await insertWebhookEvent(
            REAL_ORG_ID,
            conversationId,
            buildWhatsappPayload(conversationId, phone, [{ role: 'user', message: 'Hola de nuevo' }])
        );

        await processCallCompletedHandler(buildFakeFastify(), buildJob(webhookEventId));

        // Simula que el job se reintenta antes de que processed_at quedara
        // marcado (p. ej. una notificación de Fase 4 falló después del
        // respaldo de whatsapp_messages) — el mismo conversation_id, mismo
        // transcript.
        await supabaseAdmin.from('webhook_events').update({ processed_at: null }).eq('id', webhookEventId);
        await processCallCompletedHandler(buildFakeFastify(), buildJob(webhookEventId));

        const { data: contact } = await supabaseAdmin
            .from('contacts')
            .select('id')
            .eq('organization_id', REAL_ORG_ID)
            .eq('phone_e164', phone)
            .single();

        const { data: messages } = await supabaseAdmin.from('whatsapp_messages').select('id').eq('contact_id', contact!.id);
        expect(messages).toHaveLength(1);
    });

    it('contraparte de rechazo: conversación de voz (no WhatsApp) no escribe en whatsapp_messages', async () => {
        const conversationId = `whatsapp-messages-test:${Date.now()}:voice`;
        const phone = randomMxPhone();
        createdConversationIds.push(conversationId);
        createdPhones.push(phone);

        const webhookEventId = await insertWebhookEvent(REAL_ORG_ID, conversationId, buildVoicePayload(conversationId, phone));
        await processCallCompletedHandler(buildFakeFastify(), buildJob(webhookEventId));

        const { data: contact } = await supabaseAdmin
            .from('contacts')
            .select('id')
            .eq('organization_id', REAL_ORG_ID)
            .eq('phone_e164', phone)
            .single();

        const { data: messages } = await supabaseAdmin.from('whatsapp_messages').select('id').eq('contact_id', contact!.id);
        expect(messages).toHaveLength(0);
    });

    it('conversación de WhatsApp con transcript vacío: no falla y no inserta ningún mensaje', async () => {
        const conversationId = `whatsapp-messages-test:${Date.now()}:empty`;
        const phone = randomMxPhone();
        createdConversationIds.push(conversationId);
        createdPhones.push(phone);

        const webhookEventId = await insertWebhookEvent(REAL_ORG_ID, conversationId, buildWhatsappPayload(conversationId, phone, []));

        await expect(processCallCompletedHandler(buildFakeFastify(), buildJob(webhookEventId))).resolves.not.toThrow();

        const { data: contact } = await supabaseAdmin
            .from('contacts')
            .select('id')
            .eq('organization_id', REAL_ORG_ID)
            .eq('phone_e164', phone)
            .maybeSingle();

        if (contact?.id) {
            const { data: messages } = await supabaseAdmin.from('whatsapp_messages').select('id').eq('contact_id', contact.id);
            expect(messages).toHaveLength(0);
        }
    });
});
