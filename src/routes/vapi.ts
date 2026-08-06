import { FastifyPluginAsync } from 'fastify';
import { supabaseAdmin } from '../lib/supabase.js';
import { searchKnowledgeBase } from '../services/rag.js';
import { handleCalendarToolCall } from '../services/calendar.js';
import { enqueueCallProcessingJob } from '../queues/callProcessor.js';

interface VapiWebhookBody {
    message?: {
        type?: string;
        call?: {
            id?: string;
            type?: 'inbound' | 'outbound' | string;
            assistantId?: string;
            durationSeconds?: number;
            transcript?: string;
            summary?: string;
            cost?: number;
            customer?: {
                number?: string;
            };
            phoneNumber?: {
                number?: string;
            };
        };
        assistant?: {
            id?: string;
        };
        transcript?: string;
        summary?: string;
        cost?: number;
        // Campos para tool-calls o function-call
        toolCalls?: Array<{
            id?: string;
            toolCallId?: string;
            function?: {
                name?: string;
                arguments?: any;
            };
            name?: string;
            arguments?: any;
        }>;
        toolCallList?: Array<{
            id?: string;
            toolCallId?: string;
            function?: {
                name?: string;
                arguments?: any;
            };
            name?: string;
            arguments?: any;
        }>;
        functionCall?: {
            id?: string;
            name?: string;
            parameters?: any;
            arguments?: any;
        };
    };
}

/**
 * Plugin de Fastify para procesar webhooks de Vapi AI en tiempo real.
 */
export const vapiRoutes: FastifyPluginAsync = async (fastify) => {
    const handleVapiWebhook = async (request: any, reply: any) => {
        try {
            const body = request.body || {};
            const message = body.message;

            if (!message || !message.type) {
                fastify.log.info({ body }, 'Webhook de Vapi recibido sin propiedad message.type');
                return reply.status(200).send({ received: true });
            }

            const messageType = message.type;
            fastify.log.info({ messageType }, 'Procesando evento de Vapi AI');

            // -----------------------------------------------------------------
            // a) Eventos de tipo tool-calls o function-call (Consulta RAG & Calendario)
            // -----------------------------------------------------------------
            if (messageType === 'tool-calls' || messageType === 'function-call') {
                const toolCalls: Array<{ id: string; name: string; args: Record<string, any> }> = [];

                if (messageType === 'tool-calls') {
                    const rawList = message.toolCallList || message.toolCalls || [];
                    for (const tc of rawList) {
                        let parsedArgs = tc.function?.arguments || tc.arguments || {};
                        if (typeof parsedArgs === 'string') {
                            try {
                                parsedArgs = JSON.parse(parsedArgs);
                            } catch {
                                parsedArgs = {};
                            }
                        }
                        toolCalls.push({
                            id: tc.id || tc.toolCallId || 'call_default',
                            name: tc.function?.name || tc.name || '',
                            args: parsedArgs,
                        });
                    }
                } else if (messageType === 'function-call') {
                    const fn = message.functionCall;
                    if (fn) {
                        let parsedArgs = fn.parameters || fn.arguments || {};
                        if (typeof parsedArgs === 'string') {
                            try {
                                parsedArgs = JSON.parse(parsedArgs);
                            } catch {
                                parsedArgs = {};
                            }
                        }
                        toolCalls.push({
                            id: fn.id || 'call_default',
                            name: fn.name || '',
                            args: parsedArgs,
                        });
                    }
                }

                const results: Array<{ toolCallId: string; result: string }> = [];

                for (const call of toolCalls) {
                    if (call.name === 'searchKnowledgeBase' || call.name === 'search_knowledge_base') {
                        const query = call.args.query || call.args.search || call.args.text;
                        let organizationId = call.args.organizationId || call.args.orgId || call.args.organization_id;

                        // Si no viene organizationId en los argumentos, buscar por vapiAgentId del asistente
                        const vapiAgentId = message.call?.assistantId || message.assistant?.id;
                        if (!organizationId && vapiAgentId) {
                            const { data: orgData } = await supabaseAdmin
                                .from('organizations')
                                .select('id')
                                .eq('vapi_agent_id', vapiAgentId)
                                .maybeSingle();

                            if (orgData) {
                                organizationId = orgData.id;
                            }
                        }

                        if (!query) {
                            results.push({
                                toolCallId: call.id,
                                result: 'No se proporcionó una consulta (query) válida.',
                            });
                            continue;
                        }

                        if (!organizationId) {
                            results.push({
                                toolCallId: call.id,
                                result: 'No se pudo determinar la organización asociada para la búsqueda.',
                            });
                            continue;
                        }

                        try {
                            const kbResults = await searchKnowledgeBase(organizationId, query, call.args.limit || 5);

                            let responseText = '';
                            if (Array.isArray(kbResults) && kbResults.length > 0) {
                                responseText = kbResults
                                    .map((item: any) => `[${item.title}]: ${item.content}`)
                                    .join('\n\n');
                            } else {
                                responseText = 'No se encontró información relevante en la base de conocimiento.';
                            }

                            results.push({
                                toolCallId: call.id,
                                result: responseText,
                            });
                        } catch (err: any) {
                            fastify.log.error(err, 'Error ejecutando searchKnowledgeBase en tool-call');
                            results.push({
                                toolCallId: call.id,
                                result: `Error al consultar la base de conocimiento: ${err.message}`,
                            });
                        }
                    } else if (
                        call.name === 'checkAvailability' ||
                        call.name === 'getAvailableSlots' ||
                        call.name === 'check_availability' ||
                        call.name === 'bookAppointment' ||
                        call.name === 'createBooking' ||
                        call.name === 'book_appointment' ||
                        call.name === 'rescheduleAppointment' ||
                        call.name === 'modifyAppointment' ||
                        call.name === 'updateAppointment' ||
                        call.name === 'changeAppointment' ||
                        call.name === 'confirmAppointment' ||
                        call.name === 'confirm_appointment' ||
                        call.name === 'cancelAppointment' ||
                        call.name === 'cancel_appointment'
                    ) {
                        try {
                            // Resolver organizationId si no fue enviado explícitamente por el modelo
                            const vapiAgentId = message.call?.assistantId || message.assistant?.id;
                            if (!call.args.organizationId && vapiAgentId) {
                                const { data: orgData } = await supabaseAdmin
                                    .from('organizations')
                                    .select('id')
                                    .eq('vapi_agent_id', vapiAgentId)
                                    .maybeSingle();

                                if (orgData) {
                                    call.args.organizationId = orgData.id;
                                }
                            }

                            // Resolver callLogId si está disponible
                            if (!call.args.callLogId && message.call?.id) {
                                call.args.callLogId = message.call.id;
                            }

                            const responseText = await handleCalendarToolCall(call.name, call.args);
                            results.push({
                                toolCallId: call.id,
                                result: responseText,
                            });
                        } catch (err: any) {
                            fastify.log.error(err, 'Error ejecutando herramienta de calendario en tool-call');
                            results.push({
                                toolCallId: call.id,
                                result: `Error al procesar la solicitud de calendario: ${err.message}`,
                            });
                        }
                    }
                }

                return reply.status(200).send({ results });
            }

            // -----------------------------------------------------------------
            // b) Evento end-of-call-report (Reporte al finalizar la llamada)
            // -----------------------------------------------------------------
            if (messageType === 'end-of-call-report') {
                const call = message.call || {};

                const vapiCallId = call.id || null;
                const callerPhone = call.customer?.number || null;
                const agentPhone = call.phoneNumber?.number || null;
                const type = call.type || null; // 'inbound' | 'outbound'
                const durationSeconds = typeof call.durationSeconds === 'number' ? call.durationSeconds : null;
                const transcript = message.transcript || call.transcript || null;
                const summary = message.summary || call.summary || null;
                const cost = typeof message.cost === 'number' ? message.cost : (typeof call.cost === 'number' ? call.cost : null);
                const vapiAgentId = call.assistantId || message.assistant?.id || null;

                let organizationId: string | null = null;
                if (vapiAgentId) {
                    const { data: orgData, error: orgError } = await supabaseAdmin
                        .from('organizations')
                        .select('id')
                        .eq('vapi_agent_id', vapiAgentId)
                        .maybeSingle();

                    if (orgError) {
                        fastify.log.warn({ error: orgError.message }, 'No se pudo obtener organización por vapi_agent_id');
                    } else if (orgData) {
                        organizationId = orgData.id;
                    }
                }

                // Inserción exacta según el esquema real de Supabase:
                // Columnas de call_logs: id, organization_id, provider_call_id (o vapi_call_id), caller_phone, agent_phone, call_type, duration_seconds, transcript, summary, sentiment, status, cost, created_at
                const payload: Record<string, any> = {
                    organization_id: organizationId,
                    provider_call_id: vapiCallId,
                    caller_phone: callerPhone,
                    agent_phone: agentPhone,
                    call_type: type,
                    duration_seconds: durationSeconds,
                    transcript,
                    summary,
                    status: 'completed',
                    cost,
                };

                let { data: insertedLog, error: insertError } = await supabaseAdmin
                    .from('call_logs')
                    .insert(payload)
                    .select()
                    .single();

                if (insertError && (insertError.message.includes('provider_call_id') || insertError.code === 'PGRST204')) {
                    delete payload.provider_call_id;
                    payload.vapi_call_id = vapiCallId;
                    const fallbackRes = await supabaseAdmin
                        .from('call_logs')
                        .insert(payload)
                        .select()
                        .single();
                    insertedLog = fallbackRes.data;
                    insertError = fallbackRes.error;
                }

                if (insertError) {
                    fastify.log.error({ error: insertError.message }, 'Error al guardar el reporte de llamada en call_logs');
                } else {
                    fastify.log.info({ logId: insertedLog?.id }, 'Reporte de llamada registrado exitosamente en call_logs');
                }

                // Encolar trabajo de procesamiento pos-llamada asíncrono
                enqueueCallProcessingJob({
                    callLogId: insertedLog?.id,
                    vapiCallId: vapiCallId || undefined,
                    organizationId: organizationId,
                    callerPhone: callerPhone,
                    agentPhone: agentPhone,
                    durationSeconds: durationSeconds,
                    transcript: transcript,
                    summary: summary,
                    cost: cost,
                    metadata: message,
                }).catch((jobErr: any) => {
                    fastify.log.error(jobErr, 'Error al encolar procesamiento asíncrono pos-llamada');
                });

                return reply.status(200).send({ received: true });
            }

            // -----------------------------------------------------------------
            // c) Caso por defecto para cualquier otro evento de Vapi
            // -----------------------------------------------------------------
            fastify.log.info({ messageType }, 'Evento de Vapi procesado (sin acción adicional requerida)');
            return reply.status(200).send({ received: true });

        } catch (err: any) {
            fastify.log.error(err, 'Error no controlado procesando el webhook de Vapi AI');
            return reply.status(500).send({
                status: 'error',
                message: err.message || 'Error interno del servidor al procesar el webhook',
            });
        }
    };

    // Registrar los handlers de Webhook de Vapi
    fastify.post<{ Body: VapiWebhookBody }>('/api/vapi/webhook', handleVapiWebhook);
    fastify.post<{ Body: VapiWebhookBody }>('/', handleVapiWebhook);
};

export default vapiRoutes;
