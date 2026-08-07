import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import OpenAI from 'openai';
import { SEND_CALL_SUMMARY_QUEUE } from './send-call-summary.js';

export const PROCESS_VAPI_CALL_COMPLETED_QUEUE = 'process-vapi-call-completed';

export interface ProcessVapiCallCompletedJobData {
    callLogId: string;
}

interface CallLogRow {
    id: string;
    organization_id: string | null;
    transcript: string | null;
    summary: string | null;
}

let openaiInstance: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
    if (!openaiInstance) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error('Falta OPENAI_API_KEY en las variables de entorno.');
        }
        openaiInstance = new OpenAI({ apiKey });
    }
    return openaiInstance;
}

/**
 * Reanaliza la transcripción de una llamada de Vapi AI con gpt-4o-mini para
 * enriquecer resumen y sentimiento por encima de lo que Vapi ya entrega, y
 * encola la minuta (`send-call-summary`, Fase 4.2) — que resuelve por su
 * cuenta la feature `email_summaries` e idempotencia vía
 * `call_summary_sent_at`, así que un reintento de este job (que re-encola)
 * es inofensivo.
 *
 * Un reintento SÍ puede volver a llamar a OpenAI y sobrescribir
 * summary/sentiment con un resultado equivalente — costo redundante menor,
 * aceptado deliberadamente en vez de una columna de estado adicional: el
 * efecto observable (el correo) sigue siendo estrictamente idempotente.
 */
export async function processVapiCallCompletedHandler(
    fastify: FastifyInstance,
    job: Job<ProcessVapiCallCompletedJobData>
): Promise<void> {
    const { callLogId } = job.data;

    const { data: callLog, error: fetchError } = await fastify.supabaseAdmin
        .from('call_logs')
        .select('id, organization_id, transcript, summary')
        .eq('id', callLogId)
        .single<CallLogRow>();

    if (fetchError || !callLog) {
        throw new Error(`No se encontró call_logs.id=${callLogId}: ${fetchError?.message ?? 'sin datos'}`);
    }

    const transcript = callLog.transcript || '';
    let enrichedSummary = callLog.summary || 'Sin resumen disponible';
    let sentiment = 'neutral';

    if (transcript.trim().length > 0) {
        try {
            const openai = getOpenAIClient();
            const modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';
            const completion = await openai.chat.completions.create({
                model: modelName,
                messages: [
                    {
                        role: 'system',
                        content: `Eres un asistente inteligente de análisis de llamadas para negocios.
Analiza la transcripción de la llamada y responde EXCLUSIVAMENTE con un objeto JSON estricto con la siguiente estructura:
{
  "summary": "Resumen ejecutivo en formato de viñetas claras",
  "sentiment": "positivo" | "neutral" | "urgente" | "queja",
  "customer_address": "Calle y número proporcionado por el cliente, o null si no lo mencionó",
  "customer_city": "Ciudad del cliente, o null si no se mencionó",
  "customer_state": "Estado del cliente, o null si no se mencionó",
  "customer_zip": "Código postal del cliente, o null si no se mencionó"
}`,
                    },
                    {
                        role: 'user',
                        content: `Transcripción de la llamada:\n${transcript}`,
                    },
                ],
                response_format: { type: 'json_object' },
            });

            const rawContent = completion.choices[0]?.message?.content || '{}';
            const analysisResult = JSON.parse(rawContent);

            if (analysisResult.summary) enrichedSummary = analysisResult.summary;
            if (analysisResult.sentiment) sentiment = analysisResult.sentiment;

            const cAddr = analysisResult.customer_address;
            const cCity = analysisResult.customer_city;
            const cState = analysisResult.customer_state;
            const cZip = analysisResult.customer_zip;

            if (cAddr && cAddr !== 'null') {
                const locParts = [cAddr, cCity, cState, cZip].filter((p) => p && p !== 'null');
                enrichedSummary += `\n\n📍 Ubicación identificada: ${locParts.join(', ')}`;
            }

            fastify.log.info({ callLogId, sentiment }, 'process-vapi-call-completed: análisis con gpt-4o-mini completado');
        } catch (aiErr: any) {
            if (aiErr.status === 429 || aiErr.message?.includes('quota')) {
                fastify.log.warn({ callLogId }, 'process-vapi-call-completed: cuota de OpenAI agotada, se usa el resumen de Vapi AI');
            } else {
                fastify.log.error({ err: aiErr, callLogId }, 'process-vapi-call-completed: error al generar análisis con gpt-4o-mini');
            }
        }
    }

    const { error: updateError } = await fastify.supabaseAdmin
        .from('call_logs')
        .update({ summary: enrichedSummary, sentiment })
        .eq('id', callLogId);

    if (updateError) {
        throw new Error(`No se pudo actualizar call_logs.id=${callLogId}: ${updateError.message}`);
    }

    if (callLog.organization_id) {
        await fastify.pgBoss.send(SEND_CALL_SUMMARY_QUEUE, { callLogId });
    } else {
        fastify.log.info({ callLogId }, 'process-vapi-call-completed: sin organization_id, se omite la minuta por correo');
    }
}

/**
 * Registra la cola y el worker de pg-boss para `process-vapi-call-completed`.
 */
export async function registerProcessVapiCallCompletedWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(PROCESS_VAPI_CALL_COMPLETED_QUEUE, {
        retryLimit: 5,
        retryBackoff: true,
    });

    await fastify.pgBoss.work<ProcessVapiCallCompletedJobData>(PROCESS_VAPI_CALL_COMPLETED_QUEUE, async ([job]) => {
        await processVapiCallCompletedHandler(fastify, job);
    });
}
