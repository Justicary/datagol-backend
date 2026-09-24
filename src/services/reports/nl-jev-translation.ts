import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isJevConfigValidated } from '../jev-config-service.js';
import { evaluateJevDecision } from '../jev-decision-service.js';
import type { JevChoiceAnswer, JevQuestions } from '../jev/jev-decisions-client.js';
import { ALL_INTENTS, getIntentByKey } from './intents/index.js';
import {
    NL_COMPARE_TO_DIMENSIONS,
    NL_PERIOD_TYPES,
    type NlCompareToDimension,
    type NlPeriodType,
    type NlIntentDefinition,
    type NlTranslationSuccess,
} from '../../types/natural-reports.js';

/**
 * Camino rápido de traducción NL → intención con Jev (docs/jev-typesafe-manual.md,
 * docs/natural-language-reports.md). Jev solo CLASIFICA: elige la intención
 * del catálogo, el tipo de periodo y la comparación. Cualquier cosa que
 * requiera redactar (pregunta de aclaración) o extraer valores libres
 * (N días, fechas, estado, canal, límite) se deja al LLM.
 *
 * Opcional por diseño: solo se intenta si la organización tiene Jev
 * configurado y validado, y el llamador (`translateQuestion`) ya exigió el
 * LLM BYOK antes de llegar aquí. Si Jev no resuelve con confianza suficiente,
 * devuelve `fallback` y el LLM traduce exactamente como antes.
 */

/**
 * Confianza mínima de cada respuesta de Jev para aceptarla sin el LLM. Por
 * debajo, la pregunta se considera dudosa y la traduce el LLM. Umbral inicial
 * conservador: se ajusta con los registros `[NlTranslation]` de producción.
 */
export const JEV_NL_MIN_CONFIDENCE = 0.7;

/**
 * Probabilidad a partir de la cual se considera que la pregunta pide un
 * filtro o límite (estado, canal, cantidad, solo no leídos) que Jev no puede
 * extraer. Bajo a propósito: ante la duda, lo resuelve el LLM.
 */
export const JEV_NL_FILTER_THRESHOLD = 0.5;

/** Timeout propio: es una ruta del dashboard, el respaldo con LLM debe llegar rápido. */
export const JEV_NL_TIMEOUT_MS = 3000;

const OUT_OF_CATALOG = 'fuera_de_catalogo';
const AMBIGUOUS = 'ambigua';
const NO_PERIOD = 'sin_periodo';
const NO_COMPARISON = 'ninguna';

const PERIOD_CRITERIA: Record<NlPeriodType | typeof NO_PERIOD, string> = {
    [NL_PERIOD_TYPES.HOY]: 'Hoy, el día de hoy',
    [NL_PERIOD_TYPES.AYER]: 'Ayer',
    [NL_PERIOD_TYPES.ESTA_SEMANA]: 'Esta semana, la semana en curso',
    [NL_PERIOD_TYPES.SEMANA_PASADA]: 'La semana pasada, la semana anterior',
    [NL_PERIOD_TYPES.ESTE_MES]: 'Este mes, el mes en curso',
    [NL_PERIOD_TYPES.MES_PASADO]: 'El mes pasado, el mes anterior',
    [NL_PERIOD_TYPES.ULTIMOS_N_DIAS]: 'Una cantidad concreta de días recientes (últimos 7 días, últimos 15 días)',
    [NL_PERIOD_TYPES.RANGO_EXPLICITO]: 'Fechas o meses específicos (del 1 al 15 de marzo, en enero)',
    [NO_PERIOD]: 'No menciona ningún periodo de tiempo',
};

const PERIOD_LABELS: Record<NlPeriodType, string> = {
    [NL_PERIOD_TYPES.HOY]: 'hoy',
    [NL_PERIOD_TYPES.AYER]: 'ayer',
    [NL_PERIOD_TYPES.ESTA_SEMANA]: 'esta semana',
    [NL_PERIOD_TYPES.SEMANA_PASADA]: 'semana pasada',
    [NL_PERIOD_TYPES.ESTE_MES]: 'este mes',
    [NL_PERIOD_TYPES.MES_PASADO]: 'mes pasado',
    [NL_PERIOD_TYPES.ULTIMOS_N_DIAS]: 'últimos días',
    [NL_PERIOD_TYPES.RANGO_EXPLICITO]: 'rango de fechas',
};

/** Periodos que Jev puede resolver solo: no llevan números ni fechas. */
const SELF_CONTAINED_PERIODS: ReadonlySet<string> = new Set([
    NL_PERIOD_TYPES.HOY,
    NL_PERIOD_TYPES.AYER,
    NL_PERIOD_TYPES.ESTA_SEMANA,
    NL_PERIOD_TYPES.SEMANA_PASADA,
    NL_PERIOD_TYPES.ESTE_MES,
    NL_PERIOD_TYPES.MES_PASADO,
]);

const COMPARISON_CRITERIA: Record<NlCompareToDimension | typeof NO_COMPARISON, string> = {
    [NO_COMPARISON]: 'No pide comparar contra otro periodo',
    [NL_COMPARE_TO_DIMENSIONS.PERIODO_ANTERIOR]: 'Compara contra el periodo inmediato anterior (vs la semana/mes anterior)',
    [NL_COMPARE_TO_DIMENSIONS.MISMO_PERIODO_MES_PASADO]: 'Compara contra el mismo periodo del mes pasado',
};

/**
 * Intenciones con parámetros propios además del periodo (estado, canal,
 * límite, solo no leídos). Se deriva del `parametersSchema` de cada una para
 * no mantener una lista a mano: si una intención gana un parámetro, entra
 * sola aquí.
 */
function intentHasOwnParameters(intent: NlIntentDefinition<unknown, unknown>): boolean {
    const schema = intent.parametersSchema;
    return schema instanceof z.ZodObject && Object.keys(schema.shape).length > 0;
}

function buildQuestions() {
    const intentCriteria: Record<string, string> = {};
    for (const intent of ALL_INTENTS) {
        intentCriteria[intent.key] = `${intent.description} Ejemplos: ${intent.examples.map((e) => `"${e}"`).join(', ')}`;
    }
    intentCriteria[OUT_OF_CATALOG] =
        'Pide algo que ninguna otra opción cubre (pipeline detallado, nómina, inventario, configuración técnica de IA).';
    intentCriteria[AMBIGUOUS] = 'Pregunta vaga, sin un tema claro (¿cómo voy?, ¿está bien?, ¿qué pasó?).';

    return {
        intencion: {
            type: 'choice',
            instructions: '¿Qué reporte de negocio pide la pregunta del usuario?',
            criteria: intentCriteria,
        },
        periodo: {
            type: 'choice',
            instructions: '¿A qué periodo de tiempo se refiere la pregunta?',
            criteria: PERIOD_CRITERIA,
        },
        comparar_con: {
            type: 'choice',
            instructions: '¿La pregunta pide comparar el resultado contra otro periodo?',
            criteria: COMPARISON_CRITERIA,
        },
        menciona_filtro: {
            type: 'noul',
            instructions:
                '¿La pregunta restringe el resultado con un filtro o límite concreto (un estado como confirmadas o canceladas, un canal como WhatsApp o llamada, una cantidad como "los últimos 5", o solo los no leídos)?',
            criteria: { true: 'Menciona un filtro o límite concreto', false: 'No restringe el resultado' },
        },
    } satisfies JevQuestions;
}

/** Confianza de una respuesta `choice`; si Jev no la envía, la probabilidad de la opción elegida. */
function choiceConfidence(answer: JevChoiceAnswer): number {
    return answer.confidence ?? answer.probabilities[answer.choice] ?? 0;
}

function humanizeIntentKey(key: string): string {
    const text = key.replace(/_/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

export type JevTranslationFallbackReason =
    | 'jev_no_configurado'
    | 'jev_fallo'
    | 'intencion_fuera_de_catalogo'
    | 'pregunta_ambigua'
    | 'intencion_baja_confianza'
    | 'requiere_filtro'
    | 'periodo_baja_confianza'
    | 'periodo_con_valores'
    | 'comparacion_baja_confianza';

export type JevTranslationAttempt =
    | { status: 'resolved'; result: NlTranslationSuccess; confidence: number }
    | { status: 'fallback'; reason: JevTranslationFallbackReason; detail?: string };

/**
 * Intenta traducir la pregunta solo con Jev. Nunca lanza: cualquier error
 * (configuración ilegible, proveedor caído) se reporta como `fallback` para
 * que el LLM traduzca.
 */
export async function tryTranslateWithJev(
    fastify: FastifyInstance,
    organizationId: string,
    question: string
): Promise<JevTranslationAttempt> {
    try {
        if (!(await isJevConfigValidated(fastify, organizationId))) {
            return { status: 'fallback', reason: 'jev_no_configurado' };
        }

        const outcome = await evaluateJevDecision(fastify, organizationId, {
            state: { pregunta: question },
            questions: buildQuestions(),
            timeoutMs: JEV_NL_TIMEOUT_MS,
        });
        if (!outcome.ok) {
            return { status: 'fallback', reason: 'jev_fallo', detail: outcome.reason };
        }

        const { intencion, periodo, comparar_con, menciona_filtro } = outcome.answers;

        if (intencion.choice === AMBIGUOUS) return { status: 'fallback', reason: 'pregunta_ambigua' };
        // `fuera_de_catalogo` (o cualquier opción que no sea una intención) no
        // existe en el catálogo: la pregunta la juzga el LLM.
        const intentDef = getIntentByKey(intencion.choice);
        if (!intentDef) return { status: 'fallback', reason: 'intencion_fuera_de_catalogo' };

        const intentConfidence = choiceConfidence(intencion);
        if (intentConfidence < JEV_NL_MIN_CONFIDENCE) {
            return { status: 'fallback', reason: 'intencion_baja_confianza', detail: String(intentConfidence) };
        }
        if (intentHasOwnParameters(intentDef) && menciona_filtro.noul >= JEV_NL_FILTER_THRESHOLD) {
            return { status: 'fallback', reason: 'requiere_filtro', detail: String(menciona_filtro.noul) };
        }

        if (choiceConfidence(periodo) < JEV_NL_MIN_CONFIDENCE) return { status: 'fallback', reason: 'periodo_baja_confianza' };
        if (periodo.choice !== NO_PERIOD && !SELF_CONTAINED_PERIODS.has(periodo.choice)) {
            return { status: 'fallback', reason: 'periodo_con_valores', detail: periodo.choice };
        }

        if (choiceConfidence(comparar_con) < JEV_NL_MIN_CONFIDENCE) {
            return { status: 'fallback', reason: 'comparacion_baja_confianza' };
        }

        // Sin periodo explícito se usa el mismo default que el prompt del LLM.
        const periodType: NlPeriodType = periodo.choice === NO_PERIOD ? NL_PERIOD_TYPES.ESTE_MES : (periodo.choice as NlPeriodType);
        const parameters: Record<string, unknown> = { periodo: { type: periodType } };
        if (comparar_con.choice !== NO_COMPARISON) parameters.comparar_con = comparar_con.choice;

        return {
            status: 'resolved',
            confidence: intentConfidence,
            result: {
                status: 'success',
                intent: intentDef.key,
                parameters,
                interpretation: `${humanizeIntentKey(intentDef.key)}, ${PERIOD_LABELS[periodType]}`,
            },
        };
    } catch (err) {
        fastify.log.warn({ organizationId, err: (err as Error).message }, '[NlTranslation] Error inesperado en el camino de Jev');
        return { status: 'fallback', reason: 'jev_fallo', detail: 'error_inesperado' };
    }
}
