import { FastifyInstance } from 'fastify';
import { getSecret } from './secret-service.js';
import { getRate } from './rate-service.js';
import { getJevConfig } from './jev-config-service.js';
import {
    createJevDecision,
    JevRequestError,
    type JevAnswers,
    type JevQuestions,
    type JevState,
    type JevUsage,
} from './jev/jev-decisions-client.js';
import { LlmProviderError, type LlmProviderErrorKind } from './llm/llm-provider.interface.js';
import { SECRET_KEYS } from '../types/secret-keys.js';
import { USAGE_EVENT_PROVIDERS } from '../types/usage-event-provider.js';
import { JEV_USAGE_UNIT_TYPES } from '../types/usage-event-unit-type.js';

export type JevDecisionFailureReason = LlmProviderErrorKind | 'not_configured' | 'invalid_request';

export type JevDecisionOutcome<Q extends JevQuestions> =
    | { ok: true; answers: JevAnswers<Q>; model: string; usage: JevUsage }
    | { ok: false; reason: JevDecisionFailureReason };

export interface EvaluateJevDecisionParams<Q extends JevQuestions> {
    state: JevState;
    questions: Q;
    timeoutMs?: number;
}

/**
 * Punto de entrada para usar Jev desde jobs y servicios. Resuelve la
 * configuración y la llave BYOK de la organización, llama a Jev y registra
 * el consumo en `usage_events`.
 *
 * Nunca lanza: devuelve `{ ok: false, reason }` para que el llamador use su
 * camino degradado (LLM, heurística o revisión humana). No debe llamarse
 * desde `routes/tools/**` (AGENTS.md §3): es una llamada síncrona a un
 * tercero.
 */
export async function evaluateJevDecision<Q extends JevQuestions>(
    fastify: FastifyInstance,
    organizationId: string,
    params: EvaluateJevDecisionParams<Q>
): Promise<JevDecisionOutcome<Q>> {
    const config = await getJevConfig(fastify, organizationId);
    if (!config.model) {
        return { ok: false, reason: 'not_configured' };
    }

    const apiKey = await getSecret(organizationId, SECRET_KEYS.JEV_API_KEY);
    if (!apiKey) {
        return { ok: false, reason: 'not_configured' };
    }

    try {
        const result = await createJevDecision({
            apiKey,
            model: config.model,
            state: params.state,
            questions: params.questions,
            timeoutMs: params.timeoutMs,
        });

        await recordJevUsage(fastify, organizationId, {
            model: result.model,
            decisionId: result.id,
            questionKeys: Object.keys(params.questions),
            usage: result.usage,
        });

        return { ok: true, answers: result.answers, model: result.model, usage: result.usage };
    } catch (err) {
        if (err instanceof JevRequestError) {
            fastify.log.error({ organizationId, err: err.message }, '[JevDecision] Preguntas inválidas, no se llamó a Jev');
            return { ok: false, reason: 'invalid_request' };
        }

        const reason: LlmProviderErrorKind = err instanceof LlmProviderError ? err.kind : 'unknown';
        fastify.log.warn(
            {
                organizationId,
                kind: reason,
                providerMessage: err instanceof LlmProviderError ? err.providerMessage : (err as Error).message,
            },
            '[JevDecision] Falló la evaluación con Jev'
        );
        return { ok: false, reason };
    }
}

interface RecordJevUsageParams {
    model: string;
    decisionId: string | null;
    questionKeys: string[];
    usage: JevUsage;
}

/**
 * Registra los tokens de Jev en `usage_events` con la tarifa vigente de
 * `provider_rates` (0 para BYOK, ver db/migrations/73_jev_metering.sql).
 * `amount_usd` NO se envía: es una columna generada por Postgres
 * (quantity × unit_rate_usd) y rechaza cualquier valor explícito. El
 * costo real reportado por OpenRouter viaja en `metadata.provider_cost_usd`
 * para conciliación, solo en el asiento de entrada para no duplicarlo. Nunca
 * lanza: un fallo de metering no invalida una decisión ya obtenida.
 */
async function recordJevUsage(
    fastify: FastifyInstance,
    organizationId: string,
    params: RecordJevUsageParams
): Promise<void> {
    try {
        const now = new Date();
        const baseMetadata = { model: params.model, decision_id: params.decisionId, questions: params.questionKeys };
        const entries = [
            {
                unitType: JEV_USAGE_UNIT_TYPES.INPUT_TOKEN,
                quantity: params.usage.inputTokens,
                metadata: { ...baseMetadata, provider_cost_usd: params.usage.costUsd },
            },
            {
                unitType: JEV_USAGE_UNIT_TYPES.OUTPUT_TOKEN,
                quantity: params.usage.outputTokens,
                metadata: baseMetadata,
            },
        ];

        const rows: Record<string, unknown>[] = [];
        for (const entry of entries) {
            if (entry.quantity <= 0) continue;
            const rate = await getRate(fastify, USAGE_EVENT_PROVIDERS.JEV, entry.unitType, now);
            const unitRateUsd = rate?.unitRateUsd ?? 0;
            rows.push({
                organization_id: organizationId,
                provider: USAGE_EVENT_PROVIDERS.JEV,
                unit_type: entry.unitType,
                quantity: entry.quantity,
                unit_rate_usd: unitRateUsd,
                occurred_at: now.toISOString(),
                metadata: entry.metadata,
            });
        }

        if (rows.length === 0) return;

        const { error } = await fastify.supabaseAdmin.from('usage_events').insert(rows);
        if (error) {
            fastify.log.warn({ err: error.message, organizationId }, '[JevDecision] Falló el registro de consumo en usage_events');
        }
    } catch (err) {
        fastify.log.warn({ err, organizationId }, '[JevDecision] Falló el registro de consumo en usage_events');
    }
}
