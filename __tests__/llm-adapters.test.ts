import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenAiCompatibleAdapter } from '../src/services/llm/adapters/OpenAiCompatibleAdapter.js';
import { AnthropicAdapter } from '../src/services/llm/adapters/AnthropicAdapter.js';
import { GoogleAdapter } from '../src/services/llm/adapters/GoogleAdapter.js';
import { LlmProviderError } from '../src/services/llm/llm-provider.interface.js';

function mockResponse(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
}

describe('services/llm/adapters', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    describe('OpenAiCompatibleAdapter (openai / openrouter)', () => {
        const adapter = new OpenAiCompatibleAdapter();

        it('éxito: devuelve texto y conteo de tokens', async () => {
            global.fetch = vi.fn().mockResolvedValue(
                mockResponse(200, {
                    choices: [{ message: { content: 'pong' } }],
                    usage: { prompt_tokens: 3, completion_tokens: 1 },
                })
            );

            const result = await adapter.complete({ apiKey: 'sk-real', model: 'gpt-4o-mini', prompt: 'ping' });

            expect(result).toEqual({ text: 'pong', inputTokens: 3, outputTokens: 1 });
        });

        it('agrega headers de atribución de OpenRouter cuando baseUrl es openrouter.ai', async () => {
            global.fetch = vi.fn().mockResolvedValue(mockResponse(200, { choices: [{ message: { content: 'ok' } }] }));

            await adapter.complete({
                apiKey: 'sk-or',
                model: 'deepseek/deepseek-v4-flash-0731',
                prompt: 'ping',
                baseUrl: 'https://openrouter.ai/api/v1',
            });

            const call = vi.mocked(global.fetch).mock.calls[0];
            expect(call[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
            const headers = call[1]?.headers as Record<string, string>;
            expect(headers['HTTP-Referer']).toBeDefined();
            expect(headers['X-Title']).toBeDefined();
        });

        it('401 → invalid_key', async () => {
            global.fetch = vi.fn().mockResolvedValue(mockResponse(401, { error: { message: 'Invalid API key' } }));
            await expect(adapter.complete({ apiKey: 'bad', model: 'gpt-4o-mini', prompt: 'ping' })).rejects.toMatchObject({
                kind: 'invalid_key',
            } satisfies Partial<LlmProviderError>);
        });

        it('402 → no_credit', async () => {
            global.fetch = vi.fn().mockResolvedValue(mockResponse(402, { error: { message: 'Insufficient credits' } }));
            await expect(adapter.complete({ apiKey: 'sk', model: 'gpt-4o-mini', prompt: 'ping' })).rejects.toMatchObject({
                kind: 'no_credit',
            });
        });

        it('404 con mensaje de modelo → model_not_found', async () => {
            global.fetch = vi.fn().mockResolvedValue(mockResponse(404, { error: { message: 'The model "foo" does not exist' } }));
            await expect(adapter.complete({ apiKey: 'sk', model: 'foo', prompt: 'ping' })).rejects.toMatchObject({
                kind: 'model_not_found',
            });
        });

        it('fetch rechaza (red caída) → network_error', async () => {
            global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));
            await expect(adapter.complete({ apiKey: 'sk', model: 'gpt-4o-mini', prompt: 'ping' })).rejects.toMatchObject({
                kind: 'network_error',
            });
        });
    });

    describe('AnthropicAdapter', () => {
        const adapter = new AnthropicAdapter();

        it('éxito: devuelve texto y conteo de tokens', async () => {
            global.fetch = vi.fn().mockResolvedValue(
                mockResponse(200, {
                    content: [{ type: 'text', text: 'pong' }],
                    usage: { input_tokens: 4, output_tokens: 2 },
                })
            );

            const result = await adapter.complete({ apiKey: 'sk-ant', model: 'claude-sonnet', prompt: 'ping' });

            expect(result).toEqual({ text: 'pong', inputTokens: 4, outputTokens: 2 });
        });

        it('401 authentication_error → invalid_key', async () => {
            global.fetch = vi.fn().mockResolvedValue(
                mockResponse(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } })
            );
            await expect(adapter.complete({ apiKey: 'bad', model: 'claude-sonnet', prompt: 'ping' })).rejects.toMatchObject({
                kind: 'invalid_key',
            });
        });

        it('mensaje de saldo agotado → no_credit', async () => {
            global.fetch = vi.fn().mockResolvedValue(
                mockResponse(400, {
                    error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' },
                })
            );
            await expect(adapter.complete({ apiKey: 'sk', model: 'claude-sonnet', prompt: 'ping' })).rejects.toMatchObject({
                kind: 'no_credit',
            });
        });

        it('not_found_error → model_not_found', async () => {
            global.fetch = vi.fn().mockResolvedValue(
                mockResponse(404, { error: { type: 'not_found_error', message: 'model: no-existe' } })
            );
            await expect(adapter.complete({ apiKey: 'sk', model: 'no-existe', prompt: 'ping' })).rejects.toMatchObject({
                kind: 'model_not_found',
            });
        });

        it('fetch rechaza (red caída) → network_error', async () => {
            global.fetch = vi.fn().mockRejectedValue(new Error('timeout'));
            await expect(adapter.complete({ apiKey: 'sk', model: 'claude-sonnet', prompt: 'ping' })).rejects.toMatchObject({
                kind: 'network_error',
            });
        });
    });

    describe('GoogleAdapter', () => {
        const adapter = new GoogleAdapter();

        it('éxito: devuelve texto y conteo de tokens', async () => {
            global.fetch = vi.fn().mockResolvedValue(
                mockResponse(200, {
                    candidates: [{ content: { parts: [{ text: 'pong' }] } }],
                    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
                })
            );

            const result = await adapter.complete({ apiKey: 'AIza-real', model: 'gemini-2.5-flash', prompt: 'ping' });

            expect(result).toEqual({ text: 'pong', inputTokens: 5, outputTokens: 1 });
        });

        it('API key not valid → invalid_key', async () => {
            global.fetch = vi.fn().mockResolvedValue(
                mockResponse(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } })
            );
            await expect(adapter.complete({ apiKey: 'bad', model: 'gemini-2.5-flash', prompt: 'ping' })).rejects.toMatchObject({
                kind: 'invalid_key',
            });
        });

        it('RESOURCE_EXHAUSTED (429) → no_credit', async () => {
            global.fetch = vi.fn().mockResolvedValue(
                mockResponse(429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } })
            );
            await expect(adapter.complete({ apiKey: 'sk', model: 'gemini-2.5-flash', prompt: 'ping' })).rejects.toMatchObject({
                kind: 'no_credit',
            });
        });

        it('NOT_FOUND (404) → model_not_found', async () => {
            global.fetch = vi.fn().mockResolvedValue(
                mockResponse(404, { error: { code: 404, message: 'model not found', status: 'NOT_FOUND' } })
            );
            await expect(adapter.complete({ apiKey: 'sk', model: 'no-existe', prompt: 'ping' })).rejects.toMatchObject({
                kind: 'model_not_found',
            });
        });

        it('fetch rechaza (red caída) → network_error', async () => {
            global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
            await expect(adapter.complete({ apiKey: 'sk', model: 'gemini-2.5-flash', prompt: 'ping' })).rejects.toMatchObject({
                kind: 'network_error',
            });
        });
    });
});
