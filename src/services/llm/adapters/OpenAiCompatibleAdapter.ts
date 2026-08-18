import {
    ILlmProvider,
    LlmCompletionParams,
    LlmCompletionResult,
    LlmProviderError,
} from '../llm-provider.interface.js';
import { fetchWithTimeout } from '../http.js';

interface OpenAiErrorBody {
    error?: {
        message?: string;
        code?: string | number;
        type?: string;
    };
}

interface OpenAiSuccessBody {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Adaptador para cualquier proveedor con API compatible con
 * `POST /chat/completions` de OpenAI — cubre tanto `openai` como
 * `openrouter` (https://openrouter.ai/docs/quickstart: mismo contrato,
 * solo cambia `baseUrl` y un par de headers opcionales de atribución).
 */
export class OpenAiCompatibleAdapter implements ILlmProvider {
    async complete(params: LlmCompletionParams): Promise<LlmCompletionResult> {
        const baseUrl = (params.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
        const isOpenRouter = baseUrl.includes('openrouter.ai');

        let response: Response;
        try {
            response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${params.apiKey}`,
                    // Headers de atribución recomendados por OpenRouter para
                    // aparecer en su tablero de rankings — no afectan a
                    // OpenAI, así que solo se envían cuando aplica.
                    ...(isOpenRouter
                        ? { 'HTTP-Referer': 'https://datagol.net', 'X-Title': 'Datagol' }
                        : {}),
                },
                body: JSON.stringify({
                    model: params.model,
                    messages: [{ role: 'user', content: params.prompt }],
                    max_tokens: params.maxOutputTokens ?? 256,
                }),
            });
        } catch {
            throw new LlmProviderError('network_error');
        }

        const bodyText = await response.text();
        let json: OpenAiErrorBody & OpenAiSuccessBody = {};
        try {
            json = bodyText ? JSON.parse(bodyText) : {};
        } catch {
            // Respuesta no-JSON (proxy caído, HTML de error, etc.) — se trata
            // como error desconocido, nunca se descarta el status HTTP.
        }

        if (!response.ok) {
            throw classifyError(response.status, json.error);
        }

        return {
            text: json.choices?.[0]?.message?.content ?? '',
            inputTokens: json.usage?.prompt_tokens ?? 0,
            outputTokens: json.usage?.completion_tokens ?? 0,
        };
    }
}

function classifyError(status: number, error: OpenAiErrorBody['error']): LlmProviderError {
    const message = error?.message;
    const code = String(error?.code ?? error?.type ?? '');

    if (status === 401 || code === 'invalid_api_key') {
        return new LlmProviderError('invalid_key', message);
    }
    if (status === 402 || code === 'insufficient_quota' || /insufficient.*credit/i.test(message ?? '')) {
        return new LlmProviderError('no_credit', message);
    }
    if (status === 429 && /quota|insufficient/i.test(`${message ?? ''} ${code}`)) {
        return new LlmProviderError('no_credit', message);
    }
    if (code === 'model_not_found' || /model/i.test(message ?? '')) {
        return new LlmProviderError('model_not_found', message);
    }
    if (status === 404) {
        return new LlmProviderError('model_not_found', message);
    }
    return new LlmProviderError('unknown', message);
}
