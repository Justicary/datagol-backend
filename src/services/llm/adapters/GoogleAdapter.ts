import {
    ILlmProvider,
    LlmCompletionParams,
    LlmCompletionResult,
    LlmProviderError,
} from '../llm-provider.interface.js';
import { fetchWithTimeout } from '../http.js';

interface GoogleErrorBody {
    error?: { code?: number; message?: string; status?: string };
}

interface GoogleSuccessBody {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Adaptador para la API de Gemini (`generativelanguage.googleapis.com`). */
export class GoogleAdapter implements ILlmProvider {
    async complete(params: LlmCompletionParams): Promise<LlmCompletionResult> {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.model)}:generateContent?key=${encodeURIComponent(params.apiKey)}`;

        let response: Response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: params.prompt }] }],
                    generationConfig: { maxOutputTokens: params.maxOutputTokens ?? 256 },
                }),
            });
        } catch {
            throw new LlmProviderError('network_error');
        }

        const bodyText = await response.text();
        let json: GoogleErrorBody & GoogleSuccessBody = {};
        try {
            json = bodyText ? JSON.parse(bodyText) : {};
        } catch {
            // Respuesta no-JSON — se clasifica solo por status HTTP.
        }

        if (!response.ok) {
            throw classifyError(response.status, json.error);
        }

        const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

        return {
            text,
            inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
        };
    }
}

function classifyError(status: number, error: GoogleErrorBody['error']): LlmProviderError {
    const message = error?.message;
    const googleStatus = error?.status;

    if (status === 400 && /API key not valid/i.test(message ?? '')) {
        return new LlmProviderError('invalid_key', message);
    }
    if (status === 401 || status === 403 || googleStatus === 'PERMISSION_DENIED') {
        return new LlmProviderError('invalid_key', message);
    }
    if (status === 404 || googleStatus === 'NOT_FOUND') {
        return new LlmProviderError('model_not_found', message);
    }
    if (status === 429 || googleStatus === 'RESOURCE_EXHAUSTED') {
        return new LlmProviderError('no_credit', message);
    }
    return new LlmProviderError('unknown', message);
}
