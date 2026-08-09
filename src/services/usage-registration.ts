import { FastifyInstance } from 'fastify';
import { getRate } from './rate-service.js';
import { USAGE_EVENT_PROVIDERS } from '../types/usage-event-provider.js';
import { USAGE_EVENT_UNIT_TYPES, llmInputTokenUnitType, llmOutputTokenUnitType } from '../types/usage-event-unit-type.js';
import type { LlmModelTokenUsage } from './call-payload-mapper.js';

export interface CallUsageInput {
    organizationId: string;
    conversationId: string;
    durationSeconds: number;
    occurredAt: Date;
    hasPhoneCallLeg: boolean;
    /**
     * `true` para canales de texto (WhatsApp: `conversation_initiation_source
     * === 'whatsapp'` o `text_only === true`, ver call-payload-mapper.ts).
     * Cuando es `true`, `durationSeconds`/`hasPhoneCallLeg` se ignoran por
     * completo: ninguna conversación de texto genera `agent_minute` ni
     * `sip_inbound_local_mx`, sin importar qué traigan esos campos.
     */
    isTextChannel: boolean;
    /** `metadata.platform_usage.category_usage.text_message.quantity` del payload. */
    textMessageQuantity: number | null;
    /**
     * Tokens de LLM por modelo (`metadata.charging.llm_usage.irreversible_generation.model_usage`).
     * Aplica a CUALQUIER canal — el agente usa el LLM tanto en voz como en
     * WhatsApp — así que se procesa fuera de la ramificación por canal.
     * Arreglo vacío cuando el payload no trae el desglose: `resolveCallUsageEntries`
     * lo advierte con el conversation_id, nunca inventa un consumo.
     */
    llmTokenUsage: LlmModelTokenUsage[];
}

/**
 * Asiento de consumo ya resuelto (tarifa incluida), listo para insertarse en
 * `usage_events` vía el RPC `process_call_completed`. Las claves están en
 * snake_case porque viajan tal cual como parámetro `jsonb` hacia
 * `jsonb_to_recordset` en la función SQL.
 */
export interface ResolvedUsageEntry {
    provider: string;
    unit_type: string;
    quantity: number;
    unit_rate_usd: number;
    occurred_at: string;
    idempotency_key: string;
}

interface UsageCandidate {
    provider: string;
    unitType: string;
    quantity: number;
}

/**
 * Construye los asientos de consumo que corresponden a una llamada completada
 * (Fase 3.2). Alcance actual, deliberadamente acotado a lo que el payload de
 * ElevenLabs verifica: minutos de agente (solo canales de voz) y minutos de
 * telefonía entrante (solo si el payload trajo `metadata.phone_call`, es
 * decir, fue una llamada real por SIP y no una conversación de widget web).
 *
 * Canales de texto (WhatsApp): `agent_minute` NUNCA aplica — ElevenLabs no
 * sintetiza audio para esas conversaciones, así que `call_duration_secs` no
 * representa minutos de voz (una conversación de WhatsApp de 600s de
 * "duración" no son 10 minutos de agente; cobrar así sobrefacturaría al
 * cliente). Se factura por mensaje en su lugar
 * (`wa_message`, `provider: 'elevenlabs'` — ver provider_rates, nota
 * "Mensaje de texto WhatsApp"; distinto del costo de plantilla de Meta,
 * `provider: 'meta'`, que este job no cubre). Es responsabilidad de esta
 * función ramificar ANTES de tocar `durationSeconds`/`hasPhoneCallLeg`: si
 * `isTextChannel` es `true`, esos dos campos ni se leen.
 *
 * Minutos de grabación NO se incluyen aquí: el webhook `post_call_transcription`
 * no trae ese campo — solo está disponible vía el endpoint autenticado
 * `GET /v1/convai/conversations/:id`, fuera de alcance de esta fase por
 * decisión explícita.
 *
 * Tokens de LLM (`metadata.charging.llm_usage.irreversible_generation.model_usage`,
 * verificado contra payloads reales de producción — la documentación pública
 * no lo detalla) SÍ se incluyen, en cualquier canal: el agente consume LLM
 * tanto para responder por voz como por WhatsApp. Se usa
 * `irreversible_generation`, nunca `initiated_generation` — esta última
 * cuenta reintentos internos del LLM que no se llegaron a facturar,
 * contarla duplicaría tokens frente a la factura real de ElevenLabs.
 */
function buildLlmTokenCandidates(usage: LlmModelTokenUsage[]): UsageCandidate[] {
    const candidates: UsageCandidate[] = [];

    for (const modelUsage of usage) {
        if (modelUsage.inputTokens > 0) {
            candidates.push({
                provider: USAGE_EVENT_PROVIDERS.ELEVENLABS,
                unitType: llmInputTokenUnitType(modelUsage.model),
                quantity: modelUsage.inputTokens,
            });
        }
        if (modelUsage.outputTokens > 0) {
            candidates.push({
                provider: USAGE_EVENT_PROVIDERS.ELEVENLABS,
                unitType: llmOutputTokenUnitType(modelUsage.model),
                quantity: modelUsage.outputTokens,
            });
        }
    }

    return candidates;
}

function buildCallUsageCandidates(input: CallUsageInput): UsageCandidate[] {
    const llmCandidates = buildLlmTokenCandidates(input.llmTokenUsage);

    if (input.isTextChannel) {
        const candidates: UsageCandidate[] = [...llmCandidates];

        if (input.textMessageQuantity && input.textMessageQuantity > 0) {
            candidates.push({
                provider: USAGE_EVENT_PROVIDERS.ELEVENLABS,
                unitType: USAGE_EVENT_UNIT_TYPES.WA_MESSAGE,
                quantity: input.textMessageQuantity,
            });
        }

        return candidates;
    }

    const minutes = input.durationSeconds / 60;

    const candidates: UsageCandidate[] = [
        { provider: USAGE_EVENT_PROVIDERS.ELEVENLABS, unitType: USAGE_EVENT_UNIT_TYPES.AGENT_MINUTE, quantity: minutes },
        ...llmCandidates,
    ];

    if (input.hasPhoneCallLeg) {
        candidates.push({
            provider: USAGE_EVENT_PROVIDERS.TELNYX,
            unitType: USAGE_EVENT_UNIT_TYPES.SIP_INBOUND_LOCAL_MX,
            quantity: minutes,
        });
    }

    return candidates;
}

/**
 * Resuelve los asientos de consumo de una llamada: por cada candidato busca
 * su tarifa vigente en `occurredAt` (§3.1). Si no hay tarifa para algún
 * candidato, ese asiento se omite y se registra una advertencia — nunca se
 * inventa una tarifa para poder insertar de todos modos (regla de honestidad
 * de datos, AGENTS.md).
 */
export async function resolveCallUsageEntries(
    fastify: FastifyInstance,
    input: CallUsageInput
): Promise<ResolvedUsageEntry[]> {
    if (input.llmTokenUsage.length === 0) {
        // Mismo principio que el fix de WhatsApp: si el payload no trae los
        // datos, no se inventa nada — pero a diferencia de wa_message (donde
        // una cantidad ausente es un caso legítimo y silencioso), aquí SÍ se
        // advierte con el conversation_id: toda conversación real pasa por un
        // LLM, así que un payload sin metadata.charging.llm_usage.irreversible_generation.model_usage
        // es una señal de que ElevenLabs cambió el shape del payload, no de
        // que no hubo consumo.
        fastify.log.warn(
            { organizationId: input.organizationId, conversationId: input.conversationId },
            'metering: el payload no trae metadata.charging.llm_usage.irreversible_generation.model_usage; no se registra consumo de tokens de LLM para esta conversación',
        );
    }

    const candidates = buildCallUsageCandidates(input);
    const resolved: ResolvedUsageEntry[] = [];

    for (const candidate of candidates) {
        const rate = await getRate(fastify, candidate.provider, candidate.unitType, input.occurredAt);

        if (!rate) {
            fastify.log.warn(
                {
                    organizationId: input.organizationId,
                    conversationId: input.conversationId,
                    provider: candidate.provider,
                    unitType: candidate.unitType,
                    occurredAt: input.occurredAt.toISOString(),
                },
                'metering: no hay tarifa vigente en provider_rates para este asiento; se omite en vez de inventar una tarifa',
            );
            continue;
        }

        resolved.push({
            provider: candidate.provider,
            unit_type: candidate.unitType,
            quantity: candidate.quantity,
            unit_rate_usd: rate.unitRateUsd,
            occurred_at: input.occurredAt.toISOString(),
            idempotency_key: `${input.conversationId}:${candidate.provider}:${candidate.unitType}`,
        });
    }

    return resolved;
}
