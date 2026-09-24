import { z } from 'zod';

/**
 * Esquemas Zod de `routes/organization-jev.ts`. Mismo estilo que
 * `src/schemas/llm.ts`: un schema de body/response por endpoint, validado
 * explícitamente en el handler.
 *
 * El modelo es un slug de OpenRouter (`autor/modelo`, con `~` opcional para
 * los alias que siguen siempre a la última versión, p. ej.
 * `~typesafe/jev-latest`). No se fija un valor por defecto en código: el
 * identificador exacto lo captura el administrador desde el catálogo de
 * OpenRouter.
 */
export const JEV_MODEL_SLUG_PATTERN = /^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

export const jevConfigBodySchema = z.object({
    model: z
        .string()
        .trim()
        .regex(JEV_MODEL_SLUG_PATTERN, '"model" debe ser un identificador de OpenRouter con la forma "autor/modelo".'),
});
export type JevConfigBody = z.infer<typeof jevConfigBodySchema>;

export const jevConfigResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        model: z.string().nullable(),
        validatedAt: z.string().nullable(),
        lastError: z.string().nullable(),
    }),
});

export const jevValidateSuccessResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        validatedAt: z.string(),
    }),
});

export const jevValidateErrorResponseSchema = z.object({
    success: z.literal(false),
    error: z.string(),
    kind: z.enum(['invalid_key', 'no_credit', 'model_not_found', 'network_error', 'unknown', 'not_configured']),
});
