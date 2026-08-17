import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { getOrganizationFeatures } from '../services/entitlements.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { sendCallSummaryEmail } from '../services/email.js';

export const SEND_CALL_SUMMARY_QUEUE = 'send-call-summary';

export interface SendCallSummaryJobData {
    callLogId: string;
}

interface CallLogRow {
    id: string;
    organization_id: string | null;
    caller_phone: string | null;
    duration_seconds: number | null;
    transcript: string | null;
    summary: string | null;
    sentiment: string | null;
    call_summary_sent_at: string | null;
}

/**
 * Fase 4.2 — Correo de minuta al negocio por cada conversación completada.
 * Cumple el entregable comercial "minutas por correo" (feature
 * `email_summaries`). La feature se verifica AQUÍ, justo antes de enviar el
 * efecto — nunca antes de encolar (AGENTS.md §16).
 */
export async function sendCallSummaryHandler(fastify: FastifyInstance, job: Job<SendCallSummaryJobData>): Promise<void> {
    const { callLogId } = job.data;

    const { data: callLog, error: fetchError } = await fastify.supabaseAdmin
        .from('call_logs')
        .select('id, organization_id, caller_phone, duration_seconds, transcript, summary, sentiment, call_summary_sent_at')
        .eq('id', callLogId)
        .single<CallLogRow>();

    if (fetchError || !callLog) {
        throw new Error(`No se encontró call_logs.id=${callLogId}: ${fetchError?.message ?? 'sin datos'}`);
    }

    if (callLog.call_summary_sent_at) {
        // Ya enviado en una ejecución previa (reintento de pg-boss); no reenviar.
        return;
    }

    if (!callLog.organization_id) {
        throw new Error(`call_logs.id=${callLogId} no tiene organization_id resuelto`);
    }

    const features = await getOrganizationFeatures(callLog.organization_id);
    if (!features.has(FEATURE_KEYS.EMAIL_SUMMARIES)) {
        fastify.log.info(
            { callLogId, organizationId: callLog.organization_id },
            'send-call-summary: la organización no tiene la feature email_summaries habilitada, se omite'
        );
        return;
    }

    const { data: org, error: orgError } = await fastify.supabaseAdmin
        .from('organizations')
        .select('email')
        .eq('id', callLog.organization_id)
        .single();

    if (orgError || !org?.email) {
        throw new Error(`organizations.id=${callLog.organization_id} sin email de notificación: ${orgError?.message ?? 'email vacío'}`);
    }

    const response = await sendCallSummaryEmail({
        organizationId: callLog.organization_id,
        to: org.email,
        callerPhone: callLog.caller_phone ?? undefined,
        summary: callLog.summary || 'Sin resumen disponible: el prospecto no dejó datos capturables en esta llamada.',
        sentiment: callLog.sentiment ?? undefined,
        durationSeconds: callLog.duration_seconds ?? 0,
        transcript: callLog.transcript ?? undefined,
    });

    if (!response) {
        throw new Error(`No se pudo enviar la minuta de llamada para call_logs.id=${callLogId}`);
    }

    const { error: updateError } = await fastify.supabaseAdmin
        .from('call_logs')
        .update({ call_summary_sent_at: new Date().toISOString() })
        .eq('id', callLogId)
        .is('call_summary_sent_at', null);

    if (updateError) {
        fastify.log.error({ err: updateError, callLogId }, 'send-call-summary: correo enviado pero falló marcar call_summary_sent_at');
    }

    fastify.log.info({ callLogId, organizationId: callLog.organization_id }, 'send-call-summary: minuta entregada correctamente');
}

/**
 * Registra la cola y el worker de pg-boss para `send-call-summary`.
 */
export async function registerSendCallSummaryWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(SEND_CALL_SUMMARY_QUEUE, {
        retryLimit: 5,
        retryBackoff: true,
    });

    await fastify.pgBoss.work<SendCallSummaryJobData>(SEND_CALL_SUMMARY_QUEUE, async ([job]) => {
        await sendCallSummaryHandler(fastify, job);
    });
}
