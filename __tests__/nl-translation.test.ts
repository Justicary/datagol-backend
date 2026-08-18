import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTranslationPrompt, translateQuestion } from '../src/services/reports/nl-translation-service.js';
import * as secretService from '../src/services/secret-service.js';
import * as llmConfigService from '../src/services/llm-config-service.js';
import { LlmProviderFactory } from '../src/services/llm/LlmProviderFactory.js';
import { FastifyInstance } from 'fastify';

describe('services/reports/nl-translation-service.ts', () => {
    const fixedNow = new Date('2026-08-18T12:00:00.000Z');

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('construye el prompt de traducción incluyendo el catálogo y la fecha local', () => {
        const prompt = buildTranslationPrompt('¿Cuántas citas tengo hoy?', 'America/Mexico_City', fixedNow);
        expect(prompt).toContain('Eres un clasificador semántico');
        expect(prompt).toContain('listado_citas');
        expect(prompt).toContain('conteo_citas');
        expect(prompt).toContain('martes 18 de agosto de 2026');
        expect(prompt).toContain('¿Cuántas citas tengo hoy?');
    });

    it('devuelve status success cuando el LLM retorna una intención válida del catálogo', async () => {
        vi.spyOn(llmConfigService, 'getLlmConfig').mockResolvedValue({
            provider: 'openai',
            model: 'gpt-4o-mini',
            baseUrl: null,
            validatedAt: '2026-08-18T00:00:00Z',
            lastError: null,
        });
        vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-mock-key');
        vi.spyOn(llmConfigService, 'recordLlmUsage').mockResolvedValue();

        const mockProvider = {
            complete: vi.fn().mockResolvedValue({
                text: JSON.stringify({
                    status: 'success',
                    intent: 'conteo_citas',
                    parameters: { periodo: { type: 'hoy' } },
                    interpretation: 'Conteo de citas para el día de hoy',
                }),
                inputTokens: 200,
                outputTokens: 50,
            }),
        };
        vi.spyOn(LlmProviderFactory, 'getProvider').mockReturnValue(mockProvider as any);

        const mockFastify = {
            log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
            supabaseAdmin: {},
        } as unknown as FastifyInstance;

        const result = await translateQuestion(mockFastify, 'org-123', {
            question: '¿Cuántas citas tengo hoy?',
            timezone: 'America/Mexico_City',
            now: fixedNow,
        });

        expect(result.status).toBe('success');
        if (result.status === 'success') {
            expect(result.intent).toBe('conteo_citas');
            expect(result.interpretation).toBe('Conteo de citas para el día de hoy');
            expect(result.parameters).toEqual({ periodo: { type: 'hoy' } });
        }
    });

    it('devuelve requiere_aclaracion ante preguntas ambiguas', async () => {
        vi.spyOn(llmConfigService, 'getLlmConfig').mockResolvedValue({
            provider: 'openai',
            model: 'gpt-4o-mini',
            baseUrl: null,
            validatedAt: '2026-08-18T00:00:00Z',
            lastError: null,
        });
        vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-mock-key');
        vi.spyOn(llmConfigService, 'recordLlmUsage').mockResolvedValue();

        const mockProvider = {
            complete: vi.fn().mockResolvedValue({
                text: JSON.stringify({
                    status: 'requiere_aclaracion',
                    preguntaAclaracion: '¿Deseas conocer el total de citas o el total de prospectos?',
                    interpretation: 'Pregunta ambigua',
                }),
                inputTokens: 150,
                outputTokens: 30,
            }),
        };
        vi.spyOn(LlmProviderFactory, 'getProvider').mockReturnValue(mockProvider as any);

        const mockFastify = {
            log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
            supabaseAdmin: {},
        } as unknown as FastifyInstance;

        const result = await translateQuestion(mockFastify, 'org-123', {
            question: '¿cómo voy?',
            timezone: 'America/Mexico_City',
        });

        expect(result.status).toBe('requiere_aclaracion');
        if (result.status === 'requiere_aclaracion') {
            expect(result.preguntaAclaracion).toContain('total de citas o el total de prospectos');
        }
    });

    it('devuelve no_resuelta ante preguntas fuera de alcance o JSON malformado', async () => {
        vi.spyOn(llmConfigService, 'getLlmConfig').mockResolvedValue({
            provider: 'openai',
            model: 'gpt-4o-mini',
            baseUrl: null,
            validatedAt: '2026-08-18T00:00:00Z',
            lastError: null,
        });
        vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-mock-key');
        vi.spyOn(llmConfigService, 'recordLlmUsage').mockResolvedValue();

        const mockProvider = {
            complete: vi.fn().mockResolvedValue({
                text: 'Esto no es un JSON válido',
                inputTokens: 100,
                outputTokens: 10,
            }),
        };
        vi.spyOn(LlmProviderFactory, 'getProvider').mockReturnValue(mockProvider as any);

        const mockFastify = {
            log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
            supabaseAdmin: {},
        } as unknown as FastifyInstance;

        const result = await translateQuestion(mockFastify, 'org-123', {
            question: '¿cuánto inventario de productos me queda en almacén?',
        });

        expect(result.status).toBe('no_resuelta');
    });
});
