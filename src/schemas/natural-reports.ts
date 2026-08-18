import { z } from 'zod';
import {
    NL_INTENT_KEYS,
    NL_PERIOD_TYPES,
    NL_GROUP_BY_DIMENSIONS,
    NL_COMPARE_TO_DIMENSIONS,
} from '../types/natural-reports.js';

export const askReportBodySchema = z.object({
    question: z
        .string()
        .trim()
        .min(1, 'La pregunta no puede estar vacía.')
        .max(500, 'La pregunta no puede exceder 500 caracteres.'),
});

export type AskReportBody = z.infer<typeof askReportBodySchema>;

export const nlPeriodParamSchema = z.object({
    type: z.enum(Object.values(NL_PERIOD_TYPES) as [string, ...string[]]).default(NL_PERIOD_TYPES.ESTE_MES),
    n: z.number().int().positive().max(365).optional(),
    inicio: z.string().optional(),
    fin: z.string().optional(),
});

export type NlPeriodParam = z.infer<typeof nlPeriodParamSchema>;

export const nlSharedDimensionsSchema = z.object({
    periodo: nlPeriodParamSchema.optional(),
    canal: z.string().optional(),
    agrupar_por: z.enum(Object.values(NL_GROUP_BY_DIMENSIONS) as [string, ...string[]]).optional(),
    comparar_con: z.enum(Object.values(NL_COMPARE_TO_DIMENSIONS) as [string, ...string[]]).optional(),
});

export type NlSharedDimensions = z.infer<typeof nlSharedDimensionsSchema>;

// Esquema de validación para la respuesta cruda del LLM en la traducción
export const rawLlmTranslationSchema = z.union([
    z.object({
        status: z.literal('success'),
        intent: z.enum(Object.values(NL_INTENT_KEYS) as [string, ...string[]]),
        parameters: z.record(z.string(), z.unknown()).default({}),
        interpretation: z.string().min(1),
    }),
    z.object({
        status: z.literal('requiere_aclaracion'),
        preguntaAclaracion: z.string().min(1),
        interpretation: z.string().min(1),
    }),
    z.object({
        status: z.literal('no_resuelta'),
        reason: z.string().min(1),
        interpretation: z.string().min(1),
    }),
]);

export const unansweredQuestionsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    reason: z.enum(['no_resuelta', 'requiere_aclaracion', 'error']).optional(),
    organizationId: z.string().uuid().optional(),
});

export type UnansweredQuestionsQuery = z.infer<typeof unansweredQuestionsQuerySchema>;

export const genericEmptyParamsSchema = z.object({}).passthrough();
