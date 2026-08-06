import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { mapElevenLabsPayload } from '../services/call-payload-mapper.js';
import { resolveCallUsageEntries } from '../services/usage-registration.js';
import { LEAD_TEMPERATURES } from '../types/lead-enums.js';
import { NOTIFY_HOT_LEAD_QUEUE } from './notify-hot-lead.js';
import { SEND_CALL_SUMMARY_QUEUE } from './send-call-summary.js';
import { SEND_PROSPECT_SUMMARY_QUEUE } from './send-prospect-summary.js';

export const PROCESS_CALL_COMPLETED_QUEUE = 'process-call-completed';

export interface ProcessCallCompletedJobData {
    webhookEventId: string;
}

/**
 * Procesa un evento `webhook_events` de ElevenLabs ya verificado: mapea el
 * payload y lo persiste de forma atómica vía el RPC `process_call_completed`
 * (upsert de contacto, upsert de call_log, insert idempotente de lead, y
 * registro de consumo en `usage_events` — Fase 3), y encola las
 * notificaciones de Fase 4 (`notify-hot-lead`, `send-call-summary`,
 * `send-prospect-summary`).
 *
 * Las features de cada notificación (`hot_lead_alerts`, `email_summaries`)
 * se verifican dentro de cada worker, no aquí (AGENTS.md §16: "verificar la
 * feature antes de ejecutar el efecto, no antes de encolar").
 */
export async function processCallCompletedHandler(fastify: FastifyInstance, job: Job<ProcessCallCompletedJobData>): Promise<void> {
    const { webhookEventId } = job.data;

    const { data: event, error: fetchError } = await fastify.supabaseAdmin
        .from('webhook_events')
        .select('id, organization_id, raw_payload, processed_at')
        .eq('id', webhookEventId)
        .single();

    if (fetchError || !event) {
        throw new Error(`No se encontró webhook_events.id=${webhookEventId}: ${fetchError?.message ?? 'sin datos'}`);
    }

    if (event.processed_at) {
        // Ya procesado en una ejecución previa del job (reintento de pg-boss); no repetir efectos.
        return;
    }

    if (!event.organization_id) {
        throw new Error(`webhook_events.id=${webhookEventId} no tiene organization_id resuelto`);
    }

    let mapped;
    try {
        mapped = mapElevenLabsPayload(event.raw_payload);
    } catch (mapError: any) {
        await fastify.supabaseAdmin
            .from('webhook_events')
            .update({ error: mapError.message })
            .eq('id', webhookEventId);
        throw mapError;
    }

    if (!mapped) {
        // Tipo de evento fuera de alcance de la Fase 2 (p. ej. post_call_audio).
        await fastify.supabaseAdmin
            .from('webhook_events')
            .update({ processed_at: new Date().toISOString() })
            .eq('id', webhookEventId);
        return;
    }

    // Fase 3 — Metering: resuelve los asientos de consumo (tarifa histórica
    // incluida) ANTES del RPC, para insertarlos en la misma transacción que
    // el contacto/call_log/lead.
    const usageEntries = await resolveCallUsageEntries(fastify, {
        organizationId: event.organization_id,
        conversationId: mapped.conversationId,
        durationSeconds: mapped.durationSeconds,
        occurredAt: mapped.occurredAt,
        hasPhoneCallLeg: mapped.hasPhoneCallLeg,
    });

    const { data: result, error: rpcError } = await fastify.supabaseAdmin.rpc('process_call_completed', {
        p_organization_id: event.organization_id,
        p_conversation_id: mapped.conversationId,
        p_provider_call_id: mapped.providerCallId,
        p_caller_phone_e164: mapped.callerPhoneE164,
        p_full_name: mapped.fullName,
        p_email: mapped.email,
        p_business_name: mapped.businessName,
        p_business_sector: mapped.businessSector,
        p_contact_phone_raw: mapped.contactPhoneRaw,
        p_inquiry_reason: mapped.inquiryReason,
        p_temperature: mapped.temperature,
        p_booked_appointment: mapped.bookedAppointment,
        p_needs_followup: mapped.needsFollowup,
        p_followup_notes: mapped.followupNotes,
        p_call_volume: mapped.callVolume,
        p_transcript: mapped.transcript,
        p_summary: mapped.summary,
        p_duration_seconds: mapped.durationSeconds,
        p_usage_entries: usageEntries,
    });

    if (rpcError) {
        await fastify.supabaseAdmin
            .from('webhook_events')
            .update({ error: rpcError.message })
            .eq('id', webhookEventId);
        throw new Error(`process_call_completed falló para webhook_events.id=${webhookEventId}: ${rpcError.message}`);
    }

    // Fase 4 — Encolar notificaciones. Los workers vuelven a verificar sus
    // propias condiciones (idempotencia, feature, opt-out) antes de enviar
    // nada, así que reintentos de este job (que reencolarían) son inofensivos.
    if (result?.call_log_id) {
        // 4.2 — Minuta de cada conversación completada. Prioridad estándar.
        await fastify.pgBoss.send(SEND_CALL_SUMMARY_QUEUE, { callLogId: result.call_log_id });
    }

    if (result?.lead_id) {
        if (mapped.temperature === LEAD_TEMPERATURES.CALIENTE && !mapped.bookedAppointment) {
            // 4.1 — El producto: prioridad alta para cumplir el objetivo de <1 minuto.
            await fastify.pgBoss.send(NOTIFY_HOT_LEAD_QUEUE, { leadId: result.lead_id }, { priority: 10 });
        }

        if (mapped.needsFollowup) {
            // 4.3 — El worker resuelve el correo (COALESCE lead/contacto) y el opt-out.
            await fastify.pgBoss.send(SEND_PROSPECT_SUMMARY_QUEUE, { leadId: result.lead_id });
        }
    }

    await fastify.supabaseAdmin
        .from('webhook_events')
        .update({ processed_at: new Date().toISOString() })
        .eq('id', webhookEventId);

    fastify.log.info({
        webhookEventId,
        organizationId: event.organization_id,
        result,
        msg: 'process-call-completed: llamada persistida correctamente',
    });
}

/**
 * Registra la cola y el worker de pg-boss para `process-call-completed`.
 */
export async function registerProcessCallCompletedWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(PROCESS_CALL_COMPLETED_QUEUE, {
        retryLimit: 5,
        retryBackoff: true,
    });

    await fastify.pgBoss.work<ProcessCallCompletedJobData>(PROCESS_CALL_COMPLETED_QUEUE, async ([job]) => {
        await processCallCompletedHandler(fastify, job);
    });
}
