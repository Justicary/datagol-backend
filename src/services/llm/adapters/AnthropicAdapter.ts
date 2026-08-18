import {
    ILlmProvider,
    LlmCompletionParams,
    LlmCompletionResult,
    LlmProviderError,
} from '../llm-provider.interface.js';
import { fetchWithTimeout } from '../http.js';

const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicErrorBody {
    error?: { type?: string; message?: string };
}

interface AnthropicSuccessBody {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicAdapter implements ILlmProvider {
    async complete(params: LlmCompletionParams): Promise<LlmCompletionResult> {
        let response: Response;
        try {
            response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': params.apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                },
                body: JSON.stringify({
                    model: params.model,
                    max_tokens: params.maxOutputTokens ?? 256,
                    messages: [{ role: 'user', content: params.prompt }],
                }),
            });
        } catch {
            throw new LlmProviderError('network_error');
        }

        const bodyText = await response.text();
        let json: AnthropicErrorBody & AnthropicSuccessBody = {};
        try {
            json = bodyText ? JSON.parse(bodyText) : {};
        } catch {
            // Respuesta no-JSON — se clasifica solo por status HTTP.
        }

        if (!response.ok) {
            throw classifyError(response.status, json.error);
        }

        const text = (json.content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('');

        return {
            text,
            inputTokens: json.usage?.input_tokens ?? 0,
            outputTokens: json.usage?.output_tokens ?? 0,
        };
    }
}

function classifyError(status: number, error: AnthropicErrorBody['error']): LlmProviderError {
    const type = error?.type;
    const message = error?.message;

    if (status === 401 || type === 'authentication_error') {
        return new LlmProviderError('invalid_key', message);
    }
    // Anthropic no tiene un `type` dedicado para saldo agotado — el saldo
    // insuficiente llega como `invalid_request_error` (400) con este texto
    // literal en el mensaje ("Your credit balance is too low...").
    if (/credit balance/i.test(message ?? '')) {
        return new LlmProviderError('no_credit', message);
    }
    if (status === 404 || type === 'not_found_error') {
        return new LlmProviderError('model_not_found', message);
    }
    return new LlmProviderError('unknown', message);
}
