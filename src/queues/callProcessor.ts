import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { supabaseAdmin } from '../lib/supabase.js';
import { sendCallSummaryEmail } from '../services/email.js';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

/**
 * Conexión de Redis usando ioredis para BullMQ.
 */
export const redisConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
});

redisConnection.on('error', (err: any) => {
    console.warn('⚠️ Advertencia en conexión Redis:', err.message);
});

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

export const QUEUE_NAME = 'call-processing-queue';

/**
 * Cola BullMQ para el procesamiento asíncrono pos-llamada.
 */
export const callProcessingQueue = new Queue(QUEUE_NAME, {
    connection: redisConnection,
});

/**
 * Interfaz de datos para la tarea de procesamiento pos-llamada.
 */
export interface CallProcessingJobData {
    callLogId?: string;
    vapiCallId?: string;
    organizationId?: string | null;
    callerPhone?: string | null;
    agentPhone?: string | null;
    durationSeconds?: number | null;
    transcript?: string | null;
    summary?: string | null;
    cost?: number | null;
    metadata?: Record<string, any>;
}

/**
 * Encola un nuevo trabajo de procesamiento de llamada para ejecutarse en segundo plano.
 *
 * @param callData - Objeto con la información de la llamada recopilada del webhook.
 */
export async function enqueueCallProcessingJob(callData: CallProcessingJobData) {
    try {
        const job = await callProcessingQueue.add('process-call', callData, {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 5000,
            },
        });
        console.log(`📥 Trabajo de procesamiento encolado exitosamente. Job ID: ${job.id}`);
        return job;
    } catch (err: any) {
        console.error('❌ Error al encolar trabajo en BullMQ:', err.message);
        // Si Redis falla, procesamos la tarea directamente de forma síncrona en fallback
        console.log('🔄 Ejecutando procesamiento en segundo plano directo (fallback sin Redis)...');
        processCallJobDirectly(callData).catch((fallbackErr) => {
            console.error('❌ Error en procesamiento fallback directo:', fallbackErr.message);
        });
        return null;
    }
}

/**
 * Procesa la llamada mediante OpenAI (gpt-4o-mini), actualiza Supabase y envía correo por Resend.
 */
async function processCallJobDirectly(callData: CallProcessingJobData) {
    const transcript = callData.transcript || '';
    let enrichedSummary = callData.summary || 'Sin resumen disponible';
    let sentiment = 'neutral';
    let nextSteps: string[] = [];

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
  "nextSteps": ["Paso 1 accionable", "Paso 2 accionable"],
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
            if (Array.isArray(analysisResult.nextSteps)) nextSteps = analysisResult.nextSteps;

            const cAddr = analysisResult.customer_address;
            const cCity = analysisResult.customer_city;
            const cState = analysisResult.customer_state;
            const cZip = analysisResult.customer_zip;

            if (cAddr && cAddr !== 'null') {
                const locParts = [cAddr, cCity, cState, cZip].filter((p) => p && p !== 'null');
                enrichedSummary += `\n\n📍 Ubicación identificada: ${locParts.join(', ')}`;
            }

            console.log(`🧠 Análisis con gpt-4o-mini completado. Sentimiento: ${sentiment}`);
        } catch (aiErr: any) {
            if (aiErr.status === 429 || aiErr.message?.includes('quota')) {
                console.warn('⚠️ Cuota de OpenAI agotada (429). Se usará el resumen generado por Vapi AI.');
            } else {
                console.error('⚠️ Error al generar análisis con OpenAI gpt-4o-mini:', aiErr.message);
            }
        }
    }

    // Actualizar registro en Supabase (tabla call_logs)
    if (callData.callLogId || callData.vapiCallId) {
        try {
            // Intentar actualizar resumen y sentimiento (sin la columna metadata)
            const updatePayload: Record<string, any> = {
                summary: enrichedSummary,
                sentiment: sentiment,
            };

            let queryBuilder = supabaseAdmin.from('call_logs').update(updatePayload);

            if (callData.callLogId) {
                queryBuilder = queryBuilder.eq('id', callData.callLogId);
            } else if (callData.vapiCallId) {
                queryBuilder = queryBuilder.eq('vapi_call_id', callData.vapiCallId);
            }

            let { error: dbError } = await queryBuilder;

            // Fallback si la columna 'sentiment' tampoco existe en la tabla call_logs
            if (dbError && dbError.message.includes('sentiment')) {
                console.warn('⚠️ La columna "sentiment" no existe en call_logs, actualizando únicamente "summary"...');
                let fallbackBuilder = supabaseAdmin.from('call_logs').update({ summary: enrichedSummary });
                if (callData.callLogId) {
                    fallbackBuilder = fallbackBuilder.eq('id', callData.callLogId);
                } else if (callData.vapiCallId) {
                    fallbackBuilder = fallbackBuilder.eq('vapi_call_id', callData.vapiCallId);
                }
                const fallbackRes = await fallbackBuilder;
                dbError = fallbackRes.error;
            }

            if (dbError) {
                console.error('⚠️ Error al actualizar call_logs en Supabase:', dbError.message);
            } else {
                console.log('✅ Registro en call_logs actualizado exitosamente.');
            }
        } catch (dbErr: any) {
            console.error('⚠️ Error en consulta Supabase:', dbErr.message);
        }
    }

    // Consultar correo de la organización y enviar resumen por email
    if (callData.organizationId) {
        try {
            const { data: orgData } = await supabaseAdmin
                .from('organizations')
                .select('email')
                .eq('id', callData.organizationId)
                .maybeSingle();

            if (orgData && orgData.email) {
                await sendCallSummaryEmail({
                    to: orgData.email,
                    callerPhone: callData.callerPhone || 'Desconocido',
                    summary: enrichedSummary,
                    sentiment: sentiment,
                    durationSeconds: callData.durationSeconds || 0,
                    transcript: transcript,
                    nextSteps: nextSteps,
                });
            } else {
                console.log(`ℹ️ La organización ${callData.organizationId} no tiene un email configurado para notificaciones.`);
            }
        } catch (emailErr: any) {
            console.error('⚠️ Error al consultar organización o enviar correo:', emailErr.message);
        }
    }
}

/**
 * Worker de BullMQ para procesar los trabajos en segundo plano.
 */
export const callWorker = new Worker<CallProcessingJobData>(
    QUEUE_NAME,
    async (job: Job<CallProcessingJobData>) => {
        console.log(`⚙️ Procesando trabajo de llamada #${job.id}...`);
        await processCallJobDirectly(job.data);
    },
    {
        connection: redisConnection,
        concurrency: 5,
    }
);

callWorker.on('completed', (job) => {
    console.log(`✅ Trabajo #${job.id} procesado exitosamente.`);
});

callWorker.on('failed', (job, err) => {
    console.error(`❌ Trabajo #${job?.id} falló con el error:`, err.message);
});
