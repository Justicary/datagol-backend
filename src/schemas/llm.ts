import { z } from 'zod';
import { LLM_PROVIDERS } from '../types/llm-providers.js';

/**
 * Esquemas Zod de `routes/organization-llm.ts`. Estilo de
 * `src/schemas/organization-onboarding.ts`: un schema de body/response por
 * endpoint, validado explícitamente en el handler.
 *
 * `z.enum` con la tupla literal (no `ALL_LLM_PROVIDERS` reinterpretado como
 * `string[]`) para que `z.infer` produzca el tipo unión `LlmProvider`, no
 * `string` — así `LlmConfigBody` es asignable directamente a
 * `UpdateLlmConfigParams` (services/llm-config-service.ts) sin castear.
 */
export const llmConfigBodySchema = z
    .object({
        provider: z.enum([
            LLM_PROVIDERS.ANTHROPIC,
            LLM_PROVIDERS.OPENAI,
            LLM_PROVIDERS.GOOGLE,
            LLM_PROVIDERS.OPENROUTER,
        ]),
        model: z.string().min(1),
        // Solo aplica a 'openrouter' — ver .refine() abajo. Para los demás
        // proveedores se ignora si se envía (cada adaptador usa su propio
        // endpoint fijo, ver services/llm/adapters/*).
        baseUrl: z.string().url().optional(),
    })
    .refine(
        (data) => {
            if (data.provider !== 'openrouter') return true;
            return typeof data.baseUrl === 'string' && data.baseUrl.startsWith('https://');
        },
        {
            message: '"baseUrl" es obligatorio y debe empezar con "https://" cuando el proveedor es "openrouter".',
            path: ['baseUrl'],
        }
    );
export type LlmConfigBody = z.infer<typeof llmConfigBodySchema>;

export const llmConfigResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        provider: z.string().nullable(),
        model: z.string().nullable(),
        baseUrl: z.string().nullable(),
        validatedAt: z.string().nullable(),
        lastError: z.string().nullable(),
    }),
});

export const llmValidateSuccessResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        validatedAt: z.string(),
    }),
});

export const llmValidateErrorResponseSchema = z.object({
    success: z.literal(false),
    error: z.string(),
    kind: z.enum(['invalid_key', 'no_credit', 'model_not_found', 'network_error', 'unknown', 'not_configured']),
});
