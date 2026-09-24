import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchOpenRouterKeyInfo, OPENROUTER_ORIGIN } from '../src/services/jev/openrouter-key-client.js';

function mockResponse(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
}

describe('services/jev/openrouter-key-client.ts', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('éxito: consulta GET /key con la llave como Bearer y devuelve la información normalizada', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            mockResponse(200, { data: { label: 'datagol-org', limit_remaining: 12.5, is_free_tier: false, usage: 3 } })
        );

        const info = await fetchOpenRouterKeyInfo('sk-or-v1-real');

        expect(info).toEqual({ label: 'datagol-org', limitRemaining: 12.5, isFreeTier: false });
        const [url, init] = vi.mocked(global.fetch).mock.calls[0];
        expect(url).toBe('https://openrouter.ai/api/v1/key');
        expect(OPENROUTER_ORIGIN).toBe('https://openrouter.ai');
        expect(init?.method).toBe('GET');
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer sk-or-v1-real');
        expect(headers['HTTP-Referer']).toBe('https://datagol.net');
        expect(headers['X-OpenRouter-Title']).toBe('Datagol');
    });

    it('éxito: llave sin tope de gasto (limit_remaining null) → limitRemaining null', async () => {
        global.fetch = vi.fn().mockResolvedValue(mockResponse(200, { data: { label: null, limit_remaining: null } }));
        const info = await fetchOpenRouterKeyInfo('sk-or');
        expect(info).toEqual({ label: null, limitRemaining: null, isFreeTier: null });
    });

    it.each([
        [401, 'invalid_key'],
        [403, 'invalid_key'],
        [402, 'no_credit'],
        [500, 'network_error'],
        [503, 'network_error'],
        [429, 'unknown'],
        [404, 'unknown'],
    ])('status %i → kind %s, conservando el mensaje del proveedor solo en providerMessage', async (status, kind) => {
        global.fetch = vi.fn().mockResolvedValue(mockResponse(status, { error: { message: 'detalle crudo' } }));
        await expect(fetchOpenRouterKeyInfo('sk-or')).rejects.toMatchObject({ kind, providerMessage: 'detalle crudo' });
    });

    it('error sin cuerpo JSON (HTML de proxy) → se clasifica por status', async () => {
        global.fetch = vi.fn().mockResolvedValue(mockResponse(401, '<html>Unauthorized</html>'));
        await expect(fetchOpenRouterKeyInfo('sk-or')).rejects.toMatchObject({ kind: 'invalid_key', providerMessage: undefined });
    });

    it('respuesta 200 sin el formato esperado → unknown', async () => {
        global.fetch = vi.fn().mockResolvedValue(mockResponse(200, { unexpected: true }));
        await expect(fetchOpenRouterKeyInfo('sk-or')).rejects.toMatchObject({
            kind: 'unknown',
            providerMessage: 'Respuesta de /key sin el formato esperado',
        });
    });

    it('respuesta 200 con cuerpo vacío → unknown', async () => {
        global.fetch = vi.fn().mockResolvedValue(mockResponse(200, ''));
        await expect(fetchOpenRouterKeyInfo('sk-or')).rejects.toMatchObject({ kind: 'unknown' });
    });

    it('fallo de red (fetch lanza) → network_error', async () => {
        global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
        await expect(fetchOpenRouterKeyInfo('sk-or')).rejects.toMatchObject({ kind: 'network_error' });
    });
});
