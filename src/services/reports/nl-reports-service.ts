import { FastifyInstance } from 'fastify';
import { isFeatureEnabled } from '../entitlements.js';
import { isLlmConfigValidated } from '../llm-config-service.js';
import { FEATURE_KEYS } from '../../types/feature-taxonomy.js';
import {
    type AskReportResponse,
    type AskReportSuccessResponse,
    type NlCompareToDimension,
} from '../../types/natural-reports.js';
import { type NlPeriodParam } from '../../schemas/natural-reports.js';
import { resolvePeriod, DEFAULT_TIMEZONE } from './nl-dimensions.js';
import { translateQuestion } from './nl-translation-service.js';
import { executeIntent } from './nl-execution-service.js';
import { generateNarrative } from './nl-narrative-service.js';
import { recordUnansweredQuestion } from './unanswered-questions-service.js';
import { getIntentByKey } from './intents/index.js';

interface CacheEntry {
    response: AskReportSuccessResponse;
    expiresAt: number;
}

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutos
const queryCache = new Map<string, CacheEntry>();

// Rate limiting en memoria
const userMinuteHits = new Map<string, number[]>();
const orgDailyHits = new Map<string, number[]>();

const DEFAULT_DAILY_LIMIT = 100;
const DEFAULT_MINUTE_LIMIT = 10;

function cleanOldTimestamps(timestamps: number[], windowMs: number, now: number): number[] {
    return timestamps.filter((t) => now - t < windowMs);
}

export function checkRateLimits(
    organizationId: string,
    userId: string,
    dailyLimit: number = DEFAULT_DAILY_LIMIT
): { ok: boolean; message?: string } {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const oneMinuteMs = 60 * 1000;

    // Límite por minuto por usuario
    const userHits = cleanOldTimestamps(userMinuteHits.get(userId) ?? [], oneMinuteMs, now);
    if (userHits.length >= DEFAULT_MINUTE_LIMIT) {
        return {
            ok: false,
            message: `Has alcanzado el límite de ${DEFAULT_MINUTE_LIMIT} consultas por minuto. Espera un momento antes de volver a preguntar.`,
        };
    }
    userHits.push(now);
    userMinuteHits.set(userId, userHits);

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

export interface AskReportOptions {
    question: string;
    userId: string;
    now?: Date;
}

export class NaturalReportsError extends Error {
    readonly statusCode: number;
    constructor(message: string, statusCode: number = 400) {
        super(message);
        this.name = 'NaturalReportsError';
        this.statusCode = statusCode;
    }
}

export async function askReport(
    fastify: FastifyInstance,
    organizationId: string,
    options: AskReportOptions
): Promise<AskReportResponse> {
    const startTime = Date.now();
    const rawQuestion = options.question.trim();

    // 1. Verificar Entitlement
    const isEnabled = await isFeatureEnabled(organizationId, FEATURE_KEYS.NATURAL_LANGUAGE_REPORTS);
    if (!isEnabled) {
        throw new NaturalReportsError(
            'El módulo de Reportes en Lenguaje Natural no está habilitado para el plan actual de tu organización. Actualiza a plan Pro o superior.',
            403
        );
    }

    // 2. Verificar LLM Validado
    const isValidated = await isLlmConfigValidated(fastify, organizationId);
    if (!isValidated) {
        throw new NaturalReportsError(
            'Tu organización requiere una llave de IA (BYOK) configurada y validada para generar reportes en lenguaje natural. Configúrala en la sección de Ajustes > Inteligencia Artificial.',
            403
        );
    }

    // 3. Obtener configuración de zona horaria y límite de la organización
    const { data: orgData } = await fastify.supabaseAdmin
        .from('organizations')
        .select('timezone, integration_settings')
        .eq('id', organizationId)
        .maybeSingle();

    const timezone = orgData?.timezone || DEFAULT_TIMEZONE;
    const settings = (orgData?.integration_settings as Record<string, unknown>) ?? {};
    const reportsSettings = (settings.reports as Record<string, unknown>) ?? {};
    const dailyLimit = typeof reportsSettings.nl_daily_limit === 'number' ? reportsSettings.nl_daily_limit : DEFAULT_DAILY_LIMIT;

    // 4. Verificar Rate Limits
    const rateLimitCheck = checkRateLimits(organizationId, options.userId, dailyLimit);
    if (!rateLimitCheck.ok) {
        throw new NaturalReportsError(rateLimitCheck.message || 'Límite de tasa excedido.', 429);
    }

    // 5. Verificar Caché en memoria
    const normalizedKey = `${organizationId}:${rawQuestion.toLowerCase()}`;
    const cachedItem = queryCache.get(normalizedKey);
    if (cachedItem && cachedItem.expiresAt > Date.now()) {
        fastify.log.info({ organizationId, question: rawQuestion }, '[NlReports] Respuesta servida desde caché');
        return {
            ...cachedItem.response,
            cached: true,
            executionTimeMs: Date.now() - startTime,
        };
    }

    // 6. Traducción Semántica con LLM
    const translation = await translateQuestion(fastify, organizationId, {
        question: rawQuestion,
        timezone,
        now: options.now,
    });

    if (translation.status === 'requiere_aclaracion') {
        await recordUnansweredQuestion(fastify, {
            organizationId,
            question: rawQuestion,
            reason: 'requiere_aclaracion',
            metadata: { interpretation: translation.interpretation, preguntaAclaracion: translation.preguntaAclaracion },
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
            metadata: { interpretation: translation.interpretation, reason: translation.reason },
        });

        return {
            success: true,
            status: 'no_resuelta',
            interpretation: translation.interpretation,
            reason: translation.reason,
        };
    }

    // 7. Resolución de Periodo y Ejecución Determinista
    const intentDef = getIntentByKey(translation.intent);
    if (!intentDef) {
        await recordUnansweredQuestion(fastify, {
            organizationId,
            question: rawQuestion,
            reason: 'no_resuelta',
            metadata: { intent: translation.intent },
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
            metadata: { intent: translation.intent, error: errorMsg },
        });
        throw new NaturalReportsError(`Error ejecutando la consulta de reporte: ${errorMsg}`, 500);
    }

    // 8. Redacción de Frase de Contexto y Verificación Anti-Alucinación
    const narrative = await generateNarrative(fastify, organizationId, {
        question: rawQuestion,
        interpretation: translation.interpretation,
        period: resolvedPeriod,
        data: executionResult.data,
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

    // Guardar en caché
    queryCache.set(normalizedKey, {
        response: finalResponse,
        expiresAt: Date.now() + CACHE_TTL_MS,
    });

    fastify.log.info(
        {
            organizationId,
            intent: translation.intent,
            executionTimeMs,
            warningsCount: executionResult.warnings.length,
        },
        '[NlReports] Consulta de reporte en lenguaje natural ejecutada exitosamente'
    );

    return finalResponse;
}
