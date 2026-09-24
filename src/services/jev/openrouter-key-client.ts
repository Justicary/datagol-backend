import { z } from 'zod';
import { fetchWithTimeout } from '../llm/http.js';
import { LlmProviderError } from '../llm/llm-provider.interface.js';

/**
 * Origen de la API de OpenRouter. Jev se consume únicamente a través de
 * OpenRouter (cuenta BYOK de cada organización), así que es fijo — a
 * diferencia del LLM BYOK, aquí no se acepta un `baseUrl` configurable. Las
 * rutas varían por versión (`/api/v1/key`, `/api/alpha/decisions`), por eso
 * se guarda solo el origen.
 */
export const OPENROUTER_ORIGIN = 'https://openrouter.ai';

/**
 * Headers de atribución de OpenRouter. `X-OpenRouter-Title` es el nombre que
 * usa el SDK oficial (@openrouter/sdk 1.3.x); `X-Title` es el nombre anterior
 * que sigue usando OpenAiCompatibleAdapter.
 */
export const OPENROUTER_ATTRIBUTION_HEADERS = {
    'HTTP-Referer': 'https://datagol.net',
    'X-OpenRouter-Title': 'Datagol',
} as const;

/**
 * Respuesta de `GET /api/v1/key` de OpenRouter (información de la llave que
 * hace la petición). Solo se leen los campos que usa la validación; el resto
 * se descarta. `limit_remaining` es `null` cuando la llave no tiene tope de
 * gasto configurado.
 */
const openRouterKeyInfoSchema = z.object({
    data: z.object({
        label: z.string().nullish(),
        limit_remaining: z.number().nullish(),
        is_free_tier: z.boolean().nullish(),
    }),
});

export interface OpenRouterKeyInfo {
    label: string | null;
    limitRemaining: number | null;
    isFreeTier: boolean | null;
}

/**
 * Confirma que una llave de OpenRouter es válida consultando su propia
 * información. No consume tokens ni depende del formato de peticiones de
 * ningún modelo — por eso se usa para validar la cuenta BYOK de Jev en vez de
 * hacer una evaluación real.
 *
 * Lanza `LlmProviderError` con un `kind` clasificado; nunca propaga el
 * mensaje crudo del proveedor fuera de `providerMessage` (solo para logs).
 */
export async function fetchOpenRouterKeyInfo(apiKey: string): Promise<OpenRouterKeyInfo> {
    let response: Response;
    try {
        response = await fetchWithTimeout(`${OPENROUTER_ORIGIN}/api/v1/key`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                ...OPENROUTER_ATTRIBUTION_HEADERS,
            },
        });
    } catch {
        throw new LlmProviderError('network_error');
    }

    const bodyText = await response.text();
    let json: unknown = {};
    try {
        json = bodyText ? JSON.parse(bodyText) : {};
    } catch {
        // Respuesta no-JSON (proxy caído, HTML de error) — se clasifica por
        // status HTTP abajo.
    }

    if (!response.ok) {
        throw classifyError(response.status, extractOpenRouterErrorMessage(json));
    }

    const parsed = openRouterKeyInfoSchema.safeParse(json);
    if (!parsed.success) {
        throw new LlmProviderError('unknown', 'Respuesta de /key sin el formato esperado');
    }

    return {
        label: parsed.data.data.label ?? null,
        limitRemaining: parsed.data.data.limit_remaining ?? null,
        isFreeTier: parsed.data.data.is_free_tier ?? null,
    };
}

const openRouterErrorSchema = z.object({
    error: z.object({ message: z.string().optional() }),
});

/** Mensaje crudo de un cuerpo de error de OpenRouter — solo para logs internos. */
export function extractOpenRouterErrorMessage(json: unknown): string | undefined {
    const parsed = openRouterErrorSchema.safeParse(json);
    return parsed.success ? parsed.data.error.message : undefined;
}

function classifyError(status: number, message: string | undefined): LlmProviderError {
    if (status === 401 || status === 403) {
        return new LlmProviderError('invalid_key', message);
    }
    if (status === 402) {
        return new LlmProviderError('no_credit', message);
    }
    if (status >= 500) {
        return new LlmProviderError('network_error', message);
    }
    return new LlmProviderError('unknown', message);
}
