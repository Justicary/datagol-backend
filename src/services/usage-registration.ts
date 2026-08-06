import { FastifyInstance } from 'fastify';
import { getRate } from './rate-service.js';
import { USAGE_EVENT_PROVIDERS } from '../types/usage-event-provider.js';
import { USAGE_EVENT_UNIT_TYPES } from '../types/usage-event-unit-type.js';

export interface CallUsageInput {
    organizationId: string;
    conversationId: string;
    durationSeconds: number;
    occurredAt: Date;
    hasPhoneCallLeg: boolean;
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
 * ElevenLabs verifica: minutos de agente (siempre) y minutos de telefonía
 * entrante (solo si el payload trajo `metadata.phone_call`, es decir, fue una
 * llamada real por SIP y no una conversación de widget web).
 *
 * Tokens de LLM y minutos de grabación NO se incluyen aquí: el webhook
 * `post_call_transcription` no trae esos campos (verificado contra el
 * ejemplo oficial de ElevenLabs, no asumido) — solo están disponibles vía el
 * endpoint autenticado `GET /v1/convai/conversations/:id`, fuera de alcance
 * de esta fase por decisión explícita.
 */
function buildCallUsageCandidates(input: CallUsageInput): UsageCandidate[] {
    const minutes = input.durationSeconds / 60;

    const candidates: UsageCandidate[] = [
        { provider: USAGE_EVENT_PROVIDERS.ELEVENLABS, unitType: USAGE_EVENT_UNIT_TYPES.AGENT_MINUTE, quantity: minutes },
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
