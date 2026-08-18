import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkCompetitorSite } from '../src/services/competitor-scraper-service.js';

function textResponse(body: string, ok = true, status = 200): Response {
    return { ok, status, text: () => Promise.resolve(body) } as unknown as Response;
}

describe('services/competitor-scraper-service.ts', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('robots.txt prohíbe la ruta: status=blocked_by_robots, NO pide la página', async () => {
        const fetchMock = vi.fn().mockResolvedValue(textResponse('User-agent: *\nDisallow: /promos'));
        global.fetch = fetchMock;

        const result = await checkCompetitorSite('https://competidor.example.com/promos/verano');

        expect(result.status).toBe('blocked_by_robots');
        expect(fetchMock).toHaveBeenCalledTimes(1); // solo robots.txt, nunca la página
    });

    it('contraparte de éxito: robots.txt permite, extrae el texto de la página', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(textResponse('User-agent: *\nDisallow: /admin'))
            .mockResolvedValueOnce(textResponse('<html><body><h1>Promoción</h1></body></html>'));
        global.fetch = fetchMock;

        const result = await checkCompetitorSite('https://competidor.example.com/servicios');

        expect(result.status).toBe('ok');
        expect(result.text).toContain('Promoción');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('sin robots.txt (404): se trata como "permite todo" y sí pide la página', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(textResponse('', false, 404))
            .mockResolvedValueOnce(textResponse('<p>contenido</p>'));
        global.fetch = fetchMock;

        const result = await checkCompetitorSite('https://competidor.example.com/servicios');

        expect(result.status).toBe('ok');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('la página responde con error HTTP: status=http_error', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(textResponse('', false, 404))
            .mockResolvedValueOnce(textResponse('', false, 500));
        global.fetch = fetchMock;

        const result = await checkCompetitorSite('https://competidor.example.com/servicios');

        expect(result.status).toBe('http_error');
        expect(result.error).toContain('500');
    });

    it('timeout (AbortError): status=timeout', async () => {
        const fetchMock = vi.fn().mockImplementation(() => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            return Promise.reject(err);
        });
        global.fetch = fetchMock;

        const result = await checkCompetitorSite('https://competidor.example.com/servicios');

        // El primer fetch (robots.txt) también aborta y se ignora (se trata
        // como "permite todo"); el segundo (la página) sí debe reportarse.
        expect(result.status).toBe('timeout');
    });

    it('red caída (error genérico, no abort): status=network_error', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(textResponse('', false, 404))
            .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));
        global.fetch = fetchMock;

        const result = await checkCompetitorSite('https://competidor.example.com/servicios');

        expect(result.status).toBe('network_error');
    });

    it('URL inválida: no intenta ningún fetch', async () => {
        const fetchMock = vi.fn();
        global.fetch = fetchMock;

        const result = await checkCompetitorSite('no-es-una-url');

        expect(result.status).toBe('http_error');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
