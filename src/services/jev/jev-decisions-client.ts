import { z } from 'zod';
import { fetchWithTimeout } from '../llm/http.js';
import { LlmProviderError } from '../llm/llm-provider.interface.js';
import {
    OPENROUTER_ATTRIBUTION_HEADERS,
    OPENROUTER_ORIGIN,
    extractOpenRouterErrorMessage,
} from './openrouter-key-client.js';

/**
 * Cliente HTTP de la API de decisiones de OpenRouter (`POST
 * /api/alpha/decisions`), por la que se consume Jev (TypeSafe AI).
 *
 * Contrato tomado de @openrouter/sdk 1.3.23 (`alpha.decisions.create`,
 * models/decisionsrequest y models/decisionsresponse). Se usa `fetch`
 * directo en vez del SDK: el SDK reintenta 5XX con backoff hasta por una
 * hora por defecto, lo que choca con los reintentos de pg-boss (AGENTS.md
 * §8), y el contrato cabe en este archivo. La API es `alpha`: si OpenRouter
 * cambia el formato, la validación Zod de la respuesta falla ruidosamente
 * (`kind: 'unknown'`) en vez de propagar datos mal formados.
 *
 * Jev no redacta: responde preguntas tipadas sobre un estado.
 * - `noul`: probabilidad de 0 (no) a 1 (sí).
 * - `choice`: una opción de `criteria` más su distribución de probabilidad.
 * - `score`: posición en una escala ordenada de 2 a 10 niveles.
 */

export interface JevNoulQuestion {
    type: 'noul';
    instructions: string;
    /** Descripción de qué cuenta como sí/no. Opcional en la API. */
    criteria?: { true: string; false: string };
}

export interface JevChoiceQuestion<Option extends string = string> {
    type: 'choice';
    instructions: string;
    /** Opción → descripción. De 2 a 255 opciones. */
    criteria: Record<Option, string>;
}

export interface JevScoreQuestion {
    type: 'score';
    instructions: string;
    /** Niveles de la escala, del más bajo al más alto. De 2 a 10. */
    criteria: readonly string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

/** Estado a evaluar: texto libre o un objeto/arreglo estructurado. */
export type JevState = string | Record<string, unknown> | readonly unknown[];

export interface JevNoulAnswer {
    type: 'noul';
    noul: number;
}

export interface JevChoiceAnswer<Option extends string = string> {
    type: 'choice';
    choice: Option;
    confidence: number | null;
    probabilities: Partial<Record<Option, number>>;
}

export interface JevScoreAnswer {
    type: 'score';
    score: number;
    confidence: number | null;
    probabilities: Record<string, number>;
}

export type JevAnswerFor<Q> = Q extends JevNoulQuestion
    ? JevNoulAnswer
    : Q extends JevChoiceQuestion<infer Option>
      ? JevChoiceAnswer<Option>
      : Q extends JevScoreQuestion
        ? JevScoreAnswer
        : never;

/** Respuestas tipadas por pregunta: la clave y el tipo de cada una salen de las preguntas enviadas. */
export type JevAnswers<Q extends JevQuestions> = { [K in keyof Q]: JevAnswerFor<Q[K]> };

export interface JevUsage {
    inputTokens: number;
    outputTokens: number;
    /** Costo en USD que reporta OpenRouter, si lo incluye. */
    costUsd: number | null;
}

export interface JevDecisionResult<Q extends JevQuestions> {
    id: string | null;
    model: string;
    answers: JevAnswers<Q>;
    usage: JevUsage;
}

export interface CreateJevDecisionParams<Q extends JevQuestions> {
    apiKey: string;
    model: string;
    state: JevState;
    questions: Q;
    timeoutMs?: number;
}

/** Límites documentados por TypeSafe para Jev. */
export const JEV_CHOICE_MIN_OPTIONS = 2;
export const JEV_CHOICE_MAX_OPTIONS = 255;
export const JEV_SCORE_MIN_LEVELS = 2;
export const JEV_SCORE_MAX_LEVELS = 10;

const nonEmptyText = z.string().trim().min(1);

const questionSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('noul'),
        instructions: nonEmptyText,
        criteria: z.object({ true: nonEmptyText, false: nonEmptyText }).optional(),
    }),
    z.object({
        type: z.literal('choice'),
        instructions: nonEmptyText,
        criteria: z
            .record(z.string().min(1), nonEmptyText)
            .refine(
                (c) => Object.keys(c).length >= JEV_CHOICE_MIN_OPTIONS && Object.keys(c).length <= JEV_CHOICE_MAX_OPTIONS,
                `Una pregunta "choice" requiere de ${JEV_CHOICE_MIN_OPTIONS} a ${JEV_CHOICE_MAX_OPTIONS} opciones.`
            ),
    }),
    z.object({
        type: z.literal('score'),
        instructions: nonEmptyText,
        criteria: z.array(nonEmptyText).min(JEV_SCORE_MIN_LEVELS).max(JEV_SCORE_MAX_LEVELS),
    }),
]);

const questionsSchema = z
    .record(z.string().min(1), questionSchema)
    .refine((q) => Object.keys(q).length > 0, 'Se requiere al menos una pregunta.');

/** Error de programación: las preguntas o el estado no cumplen el contrato de Jev. */
export class JevRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JevRequestError';
    }
}

const probability = z.number().min(0).max(1);

const answerSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('noul'), noul: probability }),
    z.object({
        type: z.literal('choice'),
        choice: z.string(),
        confidence: probability.optional(),
        probabilities: z.record(z.string(), probability).optional(),
    }),
    z.object({
        type: z.literal('score'),
        score: z.number(),
        confidence: probability.optional(),
        probabilities: z.record(z.string(), probability).optional(),
    }),
]);

const decisionsResponseSchema = z.object({
    id: z.string().optional(),
    model: z.string(),
    // Se valida por pregunta más abajo: un tipo de respuesta desconocido para
    // una pregunta que no se hizo no debe tumbar toda la decisión.
    answers: z.record(z.string(), z.unknown()),
    usage: z.object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        cost: z.number().optional(),
    }),
});

/**
 * Evalúa las preguntas contra el estado con Jev. Devuelve respuestas
 * tipadas por pregunta, validadas contra lo que se preguntó: cada pregunta
 * tiene respuesta del mismo tipo y cada `choice` es una de sus opciones.
 *
 * Lanza `JevRequestError` si las preguntas no cumplen el contrato (bug del
 * llamador, no se envía nada) y `LlmProviderError` con `kind` clasificado
 * para cualquier fallo del proveedor o respuesta inválida.
 */
export async function createJevDecision<Q extends JevQuestions>(
    params: CreateJevDecisionParams<Q>
): Promise<JevDecisionResult<Q>> {
    const questionsResult = questionsSchema.safeParse(params.questions);
    if (!questionsResult.success) {
        throw new JevRequestError(`Preguntas inválidas para Jev: ${questionsResult.error.issues.map((i) => i.message).join('; ')}`);
    }
    if (typeof params.state === 'string' && params.state.trim() === '') {
        throw new JevRequestError('El estado a evaluar por Jev no puede estar vacío.');
    }

    let response: Response;
    try {
        response = await fetchWithTimeout(
            `${OPENROUTER_ORIGIN}/api/alpha/decisions`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Authorization: `Bearer ${params.apiKey}`,
                    ...OPENROUTER_ATTRIBUTION_HEADERS,
                },
                body: JSON.stringify({ model: params.model, state: params.state, questions: params.questions }),
            },
            params.timeoutMs
        );
    } catch {
        throw new LlmProviderError('network_error');
    }

    const bodyText = await response.text();
    let json: unknown = {};
    try {
        json = bodyText ? JSON.parse(bodyText) : {};
    } catch {
        // Respuesta no-JSON (proxy caído, HTML de error) — se clasifica abajo.
    }

    if (!response.ok) {
        throw classifyDecisionError(response.status, extractOpenRouterErrorMessage(json));
    }

    const parsed = decisionsResponseSchema.safeParse(json);
    if (!parsed.success) {
        throw new LlmProviderError('unknown', 'Respuesta de /api/alpha/decisions sin el formato esperado');
    }

    return {
        id: parsed.data.id ?? null,
        model: parsed.data.model,
        answers: parseAnswers(params.questions, parsed.data.answers),
        usage: {
            inputTokens: parsed.data.usage.input_tokens,
            outputTokens: parsed.data.usage.output_tokens,
            costUsd: parsed.data.usage.cost ?? null,
        },
    };
}

function parseAnswers<Q extends JevQuestions>(questions: Q, rawAnswers: Record<string, unknown>): JevAnswers<Q> {
    const answers: Record<string, JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer> = {};

    for (const [key, question] of Object.entries(questions)) {
        const parsed = answerSchema.safeParse(rawAnswers[key]);
        if (!parsed.success || parsed.data.type !== question.type) {
            throw new LlmProviderError('unknown', `Respuesta ausente o de tipo incorrecto para la pregunta "${key}"`);
        }

        const answer = parsed.data;
        if (answer.type === 'noul') {
            answers[key] = { type: 'noul', noul: answer.noul };
        } else if (answer.type === 'choice') {
            if (question.type === 'choice' && !Object.hasOwn(question.criteria, answer.choice)) {
                throw new LlmProviderError('unknown', `La opción "${answer.choice}" no existe en la pregunta "${key}"`);
            }
            answers[key] = {
                type: 'choice',
                choice: answer.choice,
                confidence: answer.confidence ?? null,
                probabilities: answer.probabilities ?? {},
            };
        } else {
            answers[key] = {
                type: 'score',
                score: answer.score,
                confidence: answer.confidence ?? null,
                probabilities: answer.probabilities ?? {},
            };
        }
    }

    // Seguro: cada clave de `questions` tiene una respuesta del mismo tipo que
    // su pregunta, y cada `choice` es una de sus opciones — verificado arriba.
    return answers as JevAnswers<Q>;
}

/**
 * 408/429/5XX (incluidos 524 y 529 de OpenRouter) se tratan como fallas
 * transitorias (`network_error`): el job que llama decide si reintenta.
 */
function classifyDecisionError(status: number, message: string | undefined): LlmProviderError {
    if (status === 401 || status === 403) return new LlmProviderError('invalid_key', message);
    if (status === 402) return new LlmProviderError('no_credit', message);
    if (status === 404) return new LlmProviderError('model_not_found', message);
    if (status === 408 || status === 429 || status >= 500) return new LlmProviderError('network_error', message);
    return new LlmProviderError('unknown', message);
}
