import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Job, PgBoss } from 'pg-boss';
import { z } from 'zod';
import supabasePlugin from '../src/plugins/supabase.js';
import pgBossPlugin from '../src/plugins/pg-boss.js';
import { getSecret } from '../src/services/secret-service.js';
import { mapElevenLabsPayload } from '../src/services/call-payload-mapper.js';
import {
    processCallCompletedHandler,
    PROCESS_CALL_COMPLETED_QUEUE,
    type ProcessCallCompletedJobData,
} from '../src/jobs/process-call-completed.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { WEBHOOK_EVENT_PROVIDERS } from '../src/types/webhook-provider.js';

/**
 * Backfill de una conversación de ElevenLabs cuyo webhook post-llamada nunca
 * llegó a procesarse (p. ej. el 401 de agentes secundarios en workspace
 * compartido, corregido en routes/webhooks/elevenlabs.ts).
 *
 * Reproduce el mismo camino que un webhook real, sin atajos:
 *   1. GET /v1/convai/conversations/:id con la llave de ElevenLabs de la
 *      organización (Vault; si falta, ELEVENLABS_API_KEY del entorno).
 *   2. Envuelve la respuesta como payload `post_call_transcription` y la mapea
 *      con `mapElevenLabsPayload` (falla aquí si el formato no cuadra).
 *   3. Inserta en `webhook_events` con el mismo event_id que usaría el
 *      webhook (`post_call_transcription:<conversation_id>`) — si el webhook
 *      real llegara después, se detecta como duplicado y no se reprocesa.
 *   4. Ejecuta `processCallCompletedHandler` (RPC `process_call_completed`:
 *      contacto, call_log —fusionado con la fila pre-sembrada—, lead y
 *      usage_events).
 *   5. Imprime lo que quedó en `call_logs` y `leads` para verificarlo.
 *
 * ⚠️ Notificaciones: el handler encola minuta, alerta de prospecto caliente,
 * resumen al prospecto y agradecimiento. Por defecto NO se envían (un
 * agradecimiento horas después de la llamada confunde al prospecto): se
 * registra qué se habría encolado. Con --notify se encolan en pg-boss real.
 *
 * Uso (desde Node, nunca desde el editor SQL):
 *   pnpm tsx scripts/backfill-elevenlabs-conversation.ts --org <organization_id> --conversation <conversation_id> [--dry-run] [--notify]
 */

interface ParsedArgs {
    org?: string;
    conversation?: string;
    dryRun: boolean;
    notify: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
    const parsed: ParsedArgs = { dryRun: false, notify: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--org') parsed.org = argv[++i];
        else if (argv[i] === '--conversation') parsed.conversation = argv[++i];
        else if (argv[i] === '--dry-run') parsed.dryRun = true;
        else if (argv[i] === '--notify') parsed.notify = true;
    }
    return parsed;
}

function fail(message: string): never {
    console.error(`❌ ${message}`);
    process.exit(1);
}

const conversationResponseSchema = z
    .object({
        conversation_id: z.string(),
        agent_id: z.string(),
        status: z.string().optional(),
        metadata: z
            .object({
                start_time_unix_secs: z.number().optional(),
                call_duration_secs: z.number().optional(),
            })
            .passthrough()
            .optional(),
    })
    .passthrough();

/** pg-boss simulado: registra lo que el handler habría encolado sin enviarlo. */
function skippedNotificationsQueue(skipped: Array<{ queue: string; data: unknown }>) {
    return fp(async (fastify) => {
        const fakeBoss = {
            send: async (queue: string, data: unknown) => {
                skipped.push({ queue, data });
                return null;
            },
        };
        fastify.decorate('pgBoss', fakeBoss as unknown as PgBoss);
    });
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (!args.org || !args.conversation) {
        fail(
            'Faltan --org y/o --conversation.\n   Uso: pnpm tsx scripts/backfill-elevenlabs-conversation.ts --org <id> --conversation <conv_id> [--dry-run] [--notify]'
        );
    }
    const organizationId = args.org;
    const conversationId = args.conversation;

    const skipped: Array<{ queue: string; data: unknown }> = [];
    const fastify: FastifyInstance = Fastify({ logger: { level: 'warn' } });
    await fastify.register(supabasePlugin);
    if (!args.dryRun) {
        await fastify.register(args.notify ? pgBossPlugin : skippedNotificationsQueue(skipped));
    }
    await fastify.ready();

    try {
        const { data: org } = await fastify.supabaseAdmin
            .from('organizations')
            .select('id, name')
            .eq('id', organizationId)
            .maybeSingle();
        if (!org) fail(`No existe la organización '${organizationId}'.`);
        console.log(`🏢 Organización: ${org.name} (${org.id})`);

        // 1. Conversación desde ElevenLabs
        const apiKey = (await getSecret(organizationId, SECRET_KEYS.ELEVENLABS_API_KEY)) ?? process.env.ELEVENLABS_API_KEY;
        if (!apiKey) fail('No hay llave de ElevenLabs (ni en Vault para la organización ni ELEVENLABS_API_KEY).');

        const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`, {
            headers: { 'xi-api-key': apiKey },
        });
        if (!response.ok) fail(`ElevenLabs respondió ${response.status} al pedir la conversación ${conversationId}.`);
        const parsed = conversationResponseSchema.safeParse(await response.json());
        if (!parsed.success) fail(`Respuesta de ElevenLabs con formato inesperado: ${parsed.error.message}`);
        const conversation = parsed.data;
        if (conversation.conversation_id !== conversationId) {
            fail(`ElevenLabs devolvió otra conversación (${conversation.conversation_id}).`);
        }
        console.log(`✅ 1. Conversación obtenida (agente ${conversation.agent_id}, estado ${conversation.status ?? 'n/d'})`);

        // 2. Payload post_call_transcription + mapeo
        const start = conversation.metadata?.start_time_unix_secs;
        const duration = conversation.metadata?.call_duration_secs ?? 0;
        const payload = {
            type: 'post_call_transcription',
            event_timestamp: start !== undefined ? start + duration : Math.floor(Date.now() / 1000),
            data: conversation,
        };
        const mapped = mapElevenLabsPayload(payload);
        if (!mapped) fail('El payload no se reconoció como post_call_transcription.');
        console.log('✅ 2. Payload mapeado:');
        console.log(`      duración     = ${mapped.durationSeconds} s`);
        console.log(`      turnos       = ${mapped.transcriptTurns.length}`);
        console.log(`      teléfono     = ${mapped.callerPhoneE164 ?? 'n/d'}`);
        console.log(`      temperatura  = ${mapped.temperature ?? 'n/d'}`);
        console.log(`      resumen      = ${(mapped.summary ?? 'n/d').slice(0, 160)}${(mapped.summary ?? '').length > 160 ? '…' : ''}`);

        if (args.dryRun) {
            console.log('\n🔎 --dry-run: no se escribió nada.');
            return;
        }

        // 3. webhook_events (mismo event_id que el webhook real)
        const eventId = `post_call_transcription:${conversationId}`;
        let webhookEventId: string;
        const { data: inserted, error: insertError } = await fastify.supabaseAdmin
            .from('webhook_events')
            .insert({
                organization_id: organizationId,
                provider: WEBHOOK_EVENT_PROVIDERS.ELEVENLABS,
                event_id: eventId,
                event_type: 'post_call_transcription',
                raw_payload: payload,
            })
            .select('id')
            .single();

        if (insertError) {
            if (insertError.code !== '23505') fail(`No se pudo insertar webhook_events: ${insertError.message}`);
            const { data: existing } = await fastify.supabaseAdmin
                .from('webhook_events')
                .select('id, organization_id, processed_at')
                .eq('provider', WEBHOOK_EVENT_PROVIDERS.ELEVENLABS)
                .eq('event_id', eventId)
                .maybeSingle();
            if (!existing) fail('webhook_events reportó duplicado pero no se encontró la fila existente.');
            if (existing.organization_id !== organizationId) {
                fail(`El evento ya existe para otra organización (${existing.organization_id}); no se toca.`);
            }
            if (existing.processed_at) fail(`El evento ya fue procesado el ${existing.processed_at}; no hay nada que rellenar.`);
            webhookEventId = existing.id as string;
            console.log(`✅ 3. webhook_events ya existía sin procesar (${webhookEventId}); se reutiliza`);
        } else {
            webhookEventId = inserted.id as string;
            console.log(`✅ 3. webhook_events insertado (${webhookEventId})`);
        }

        // 4. Procesamiento real (mismo handler que el worker de pg-boss)
        const job = { id: `backfill-${conversationId}`, name: PROCESS_CALL_COMPLETED_QUEUE, data: { webhookEventId } };
        await processCallCompletedHandler(fastify, job as unknown as Job<ProcessCallCompletedJobData>);
        console.log('✅ 4. process-call-completed ejecutado');
        if (args.notify) {
            console.log('      Notificaciones encoladas en pg-boss.');
        } else {
            for (const s of skipped) console.log(`      ⏭️  Notificación NO enviada (sin --notify): ${s.queue} ${JSON.stringify(s.data)}`);
        }

        // 5. Verificación
        const { data: callLog } = await fastify.supabaseAdmin
            .from('call_logs')
            .select('id, caller_phone, duration_seconds, transcript, summary')
            .eq('provider_call_id', conversationId)
            .maybeSingle();
        const { data: lead } = await fastify.supabaseAdmin
            .from('leads')
            .select('id, temperature, full_name')
            .eq('organization_id', organizationId)
            .eq('conversation_id', conversationId)
            .maybeSingle();
        if (!callLog) fail('5. No se encontró call_logs para la conversación después del procesamiento.');

        const transcriptLines = typeof callLog.transcript === 'string' ? callLog.transcript.split('\n').filter((l: string) => l.trim()).length : 0;
        console.log('✅ 5. Resultado en la base:');
        console.log(`      call_logs.id           = ${callLog.id}`);
        console.log(`      caller_phone           = ${callLog.caller_phone ?? 'n/d'}`);
        console.log(`      duration_seconds       = ${callLog.duration_seconds}`);
        console.log(`      transcript (líneas)    = ${transcriptLines}`);
        console.log(`      summary                = ${callLog.summary ? 'presente' : 'VACÍO'}`);
        console.log(`      leads.temperature      = ${lead?.temperature ?? 'n/d'} (${lead?.full_name ?? 'sin lead'})`);
        console.log('\n🎉 Backfill completado.');
    } finally {
        await fastify.close();
    }
}

main().catch((err) => {
    console.error('❌ Error inesperado:', err);
    process.exit(1);
});
