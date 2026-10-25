import { FastifyInstance } from 'fastify';
import { isFeatureEnabled } from '../entitlements.js';
import { isLlmConfigValidated } from '../llm-config-service.js';
import { FEATURE_KEYS } from '../../types/feature-taxonomy.js';
import {
    type AskReportResponse,
    type AskReportSuccessResponse,
    type NlCompareToDimension,
} from '../../types/natural-reports.js';
import type { TelegramConversationTurn } from '../../types/telegram.js';
import { type NlPeriodParam } from '../../schemas/natural-reports.js';
import { resolvePeriod, DEFAULT_TIMEZONE } from '../reports/nl-dimensions.js';
import { translateQuestion } from '../reports/nl-translation-service.js';
import { executeIntent } from '../reports/nl-execution-service.js';
import { generateNarrative } from '../reports/nl-narrative-service.js';
import { recordUnansweredQuestion } from '../reports/unanswered-questions-service.js';
import { getIntentByKey } from '../reports/intents/index.js';

export type HarnessChannel = 'dashboard' | 'telegram';

interface CacheEntry {
    response: AskReportSuccessResponse;
    expiresAt: number;
}

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutos
const queryCache = new Map<string, CacheEntry>();

// Rate limiting en memoria por identidad de canal y por organización
const userMinuteHits = new Map<string, number[]>();
const orgDailyHits = new Map<string, number[]>();

const DEFAULT_DAILY_LIMIT = 100;
const DEFAULT_MINUTE_LIMIT = 10;

function cleanOldTimestamps(timestamps: number[], windowMs: number, now: number): number[] {
    return timestamps.filter((t) => now - t < windowMs);
}

export function checkRateLimits(
    organizationId: string,
    actorKey: string,
    dailyLimit: number = DEFAULT_DAILY_LIMIT
): { ok: boolean; message?: string } {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const oneMinuteMs = 60 * 1000;

    // Límite por minuto por actor (userId en dashboard o identidad en Telegram)
    const userHits = cleanOldTimestamps(userMinuteHits.get(actorKey) ?? [], oneMinuteMs, now);
    if (userHits.length >= DEFAULT_MINUTE_LIMIT) {
        return {
            ok: false,
            message: `Has alcanzado el límite de ${DEFAULT_MINUTE_LIMIT} consultas por minuto. Espera un momento antes de volver a preguntar.`,
        };
    }
    userHits.push(now);
    userMinuteHits.set(actorKey, userHits);

    // Límite diario por organización
    const orgHits = cleanOldTimestamps(orgDailyHits.get(organizationId) ?? [], oneDayMs, now);
    if (orgHits.length >= dailyLimit) {
        return {
            ok: false,
            message: `La organización ha alcanzado el límite diario de ${dailyLimit} consultas de reportes. Este límite se restablece automáticamente cada 24 horas.`,
        };
    }
    orgHits.push(now);
    orgDailyHits.set(organizationId, orgHits);

    return { ok: true };
}

export function clearReportCaches(): void {
    queryCache.clear();
    userMinuteHits.clear();
    orgDailyHits.clear();
}

export class NaturalReportsError extends Error {
    readonly statusCode: number;
    constructor(message: string, statusCode: number = 400) {
        super(message);
        this.name = 'NaturalReportsError';
        this.statusCode = statusCode;
    }
}

export interface AskHarnessOptions {
    channel: HarnessChannel;
    actorKey: string;
    question: string;
    now?: Date;
    conversationContext?: readonly TelegramConversationTurn[];
    conversationId?: string;
}

/**
 * Arnés central canal-agnóstico de consultas de negocio en lenguaje natural.
 * Único punto del sistema que invoca `translateQuestion` y `executeIntent`
 * para el dashboard y para Telegram.
 */
export async function askHarness(
    fastify: FastifyInstance,
    organizationId: string,
    options: AskHarnessOptions
): Promise<AskReportResponse> {
    const startTime = Date.now();
    const rawQuestion = options.question.trim();

    // 1. Verificar Entitlement del canal si es Telegram
    if (options.channel === 'telegram') {
        const telegramEnabled = await isFeatureEnabled(organizationId, FEATURE_KEYS.TELEGRAM);
        if (!telegramEnabled) {
            throw new NaturalReportsError(
                'El canal de Telegram no está habilitado para el plan actual de tu organización. Actualiza a plan Pro o superior.',
                403
            );
        }
    }

    // 2. Verificar Entitlement de Reportes en Lenguaje Natural
    const isEnabled = await isFeatureEnabled(organizationId, FEATURE_KEYS.NATURAL_LANGUAGE_REPORTS);
    if (!isEnabled) {
        throw new NaturalReportsError(
            'El módulo de Reportes en Lenguaje Natural no está habilitado para el plan actual de tu organización. Actualiza a plan Pro o superior.',
            403
        );
    }

    // 3. Verificar LLM Validado
    const isValidated = await isLlmConfigValidated(fastify, organizationId);
    if (!isValidated) {
        throw new NaturalReportsError(
            'Tu organización requiere una llave de IA (BYOK) configurada y validada para generar reportes en lenguaje natural. Configúrala en la sección de Ajustes > Inteligencia Artificial.',
            403
        );
    }

    // 4. Obtener configuración de zona horaria y límite de la organización
    const { data: orgData } = await fastify.supabaseAdmin
        .from('organizations')
        .select('timezone, integration_settings')
        .eq('id', organizationId)
        .maybeSingle();

    const timezone = orgData?.timezone || DEFAULT_TIMEZONE;
    const settings = (orgData?.integration_settings as Record<string, unknown>) ?? {};
    const reportsSettings = (settings.reports as Record<string, unknown>) ?? {};
    const dailyLimit =
        typeof reportsSettings.nl_daily_limit === 'number' ? reportsSettings.nl_daily_limit : DEFAULT_DAILY_LIMIT;

    // 5. Verificar Rate Limits
    const rateLimitCheck = checkRateLimits(organizationId, options.actorKey, dailyLimit);
    if (!rateLimitCheck.ok) {
        throw new NaturalReportsError(rateLimitCheck.message || 'Límite de tasa excedido.', 429);
    }

    // 6. Verificar Caché en memoria (solo cuando no hay contexto conversacional activo que altere el significado)
    const hasConversationContext = Boolean(options.conversationContext && options.conversationContext.length > 0);
    const normalizedKey = `${organizationId}:${rawQuestion.toLowerCase()}`;
    if (!hasConversationContext) {
        const cachedItem = queryCache.get(normalizedKey);
        if (cachedItem && cachedItem.expiresAt > Date.now()) {
            fastify.log.info(
                { organizationId, channel: options.channel, question: rawQuestion },
                '[NlReports] Respuesta servida desde caché'
            );
            return {
                ...cachedItem.response,
                cached: true,
                executionTimeMs: Date.now() - startTime,
            };
        }
    }

    // 7. Traducción Semántica con LLM / Jev
    const translation = await translateQuestion(fastify, organizationId, {
        question: rawQuestion,
        timezone,
        now: options.now,
        conversationContext: options.conversationContext,
        channel: options.channel,
        conversationId: options.conversationId,
    });

    if (translation.status === 'requiere_aclaracion') {
        await recordUnansweredQuestion(fastify, {
            organizationId,
            question: rawQuestion,
            reason: 'requiere_aclaracion',
            metadata: {
                channel: options.channel,
                interpretation: translation.interpretation,
                preguntaAclaracion: translation.preguntaAclaracion,
            },
        });

        return {
            success: true,
            status: 'requiere_aclaracion',
            interpretation: translation.interpretation,
            preguntaAclaracion: translation.preguntaAclaracion,
        };
    }

    if (translation.status === 'no_resuelta') {
        await recordUnansweredQuestion(fastify, {
            organizationId,
            question: rawQuestion,
            reason: 'no_resuelta',
            metadata: {
                channel: options.channel,
                interpretation: translation.interpretation,
                reason: translation.reason,
            },
        });

        return {
            success: true,
            status: 'no_resuelta',
            interpretation: translation.interpretation,
            reason: translation.reason,
        };
    }

    // 8. Resolución de Periodo y Ejecución Determinista
    const intentDef = getIntentByKey(translation.intent);
    if (!intentDef) {
        await recordUnansweredQuestion(fastify, {
            organizationId,
            question: rawQuestion,
            reason: 'no_resuelta',
            metadata: { channel: options.channel, intent: translation.intent },
        });

        return {
            success: true,
            status: 'no_resuelta',
            interpretation: translation.interpretation,
            reason: `La intención '${translation.intent}' no se encuentra disponible.`,
        };
    }

    const periodoParam = (translation.parameters?.periodo as NlPeriodParam | undefined) ?? undefined;
    const compareToParam = (translation.parameters?.comparar_con as NlCompareToDimension | undefined) ?? undefined;

    const resolvedPeriod = resolvePeriod(periodoParam, timezone, {
        now: options.now,
        compareTo: compareToParam,
    });

    let executionResult;
    try {
        executionResult = await executeIntent(fastify, organizationId, {
            intent: translation.intent,
            parameters: translation.parameters,
            period: resolvedPeriod,
        });
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await recordUnansweredQuestion(fastify, {
            organizationId,
            question: rawQuestion,
            reason: 'error',
            metadata: { channel: options.channel, intent: translation.intent, error: errorMsg },
        });
        throw new NaturalReportsError(`Error ejecutando la consulta de reporte: ${errorMsg}`, 500);
    }

    // 9. Redacción de Frase de Contexto y Verificación Anti-Alucinación
    const narrative = await generateNarrative(fastify, organizationId, {
        question: rawQuestion,
        interpretation: translation.interpretation,
        period: resolvedPeriod,
        data: executionResult.data,
        channel: options.channel,
        conversationId: options.conversationId,
    });

    const executionTimeMs = Date.now() - startTime;

    const finalResponse: AskReportSuccessResponse = {
        success: true,
        status: 'success',
        intent: translation.intent,
        category: intentDef.category,
        interpretation: translation.interpretation,
        period: resolvedPeriod,
        shape: executionResult.shape,
        data: executionResult.data,
        narrative,
        warnings: executionResult.warnings,
        executionTimeMs,
    };

    // Guardar en caché solo si fue consulta independiente sin contexto previo
    if (!hasConversationContext) {
        queryCache.set(normalizedKey, {
            response: finalResponse,
            expiresAt: Date.now() + CACHE_TTL_MS,
        });
    }

    fastify.log.info(
        {
            organizationId,
            channel: options.channel,
            intent: translation.intent,
            executionTimeMs,
            warningsCount: executionResult.warnings.length,
        },
        '[NlReports] Consulta de reporte en lenguaje natural ejecutada exitosamente'
    );

    return finalResponse;
}
