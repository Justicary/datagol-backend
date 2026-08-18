import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    flattenNumbers,
    verifyNarrativeNumbers,
    buildNarrativePrompt,
    generateNarrative,
} from '../src/services/reports/nl-narrative-service.js';
import { resolvePeriod } from '../src/services/reports/nl-dimensions.js';
import * as secretService from '../src/services/secret-service.js';
import * as llmConfigService from '../src/services/llm-config-service.js';
import { LlmProviderFactory } from '../src/services/llm/LlmProviderFactory.js';
import { FastifyInstance } from 'fastify';

describe('services/reports/nl-narrative-service.ts — Verificación Anti-Alucinación', () => {
    const period = resolvePeriod({ type: 'este_mes' }, 'America/Mexico_City', { now: new Date('2026-08-18T12:00:00Z') });

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('aplana números de objetos y strings de forma recursiva', () => {
        const data = {
            total: 45,
            ticket: 1500.5,
            fecha: '2026-08-18',
            detalles: [{ id: 'item-1', valor: 300 }],
        };

        const numbers = flattenNumbers(data);
        expect(numbers.has(45)).toBe(true);
        expect(numbers.has(1500.5)).toBe(true);
        expect(numbers.has(2026)).toBe(true);
        expect(numbers.has(8)).toBe(true);
        expect(numbers.has(18)).toBe(true);
        expect(numbers.has(300)).toBe(true);
    });

    it('aprueba narrativas que contienen únicamente números derivados de los datos', () => {
        const data = {
            totalCitas: 45,
            asistieron: 30,
            tasaAsistencia: 66.7,
        };

        const narrative = 'Este mes se agendaron 45 citas y asistieron 30 clientes, logrando una tasa de asistencia del 66.7%.';
        const verification = verifyNarrativeNumbers(narrative, data);
        expect(verification.ok).toBe(true);
        expect(verification.unmatched).toHaveLength(0);
    });

    it('descarta narrativas que inventan una cifra no presente en los datos', () => {
        const data = {
            totalCitas: 45,
            asistieron: 30,
            tasaAsistencia: 66.7,
        };

        // Inventa "99 citas perdidas" que no está en data
        const hallucinatedNarrative = 'Se registraron 45 citas pero hubo 99 citas perdidas en el periodo.';
        const verification = verifyNarrativeNumbers(hallucinatedNarrative, data);
        expect(verification.ok).toBe(false);
        expect(verification.unmatched).toContain(99);
    });

    it('permite números pequeños conectores (menores o iguales a 12)', () => {
        const data = {
            totalCitas: 50,
        };

        // "3 principales razones" (el 3 es un conector de prosa común <= 12)
        const narrative = 'Se tuvieron 50 citas destacando las 3 principales fuentes.';
        const verification = verifyNarrativeNumbers(narrative, data);
        expect(verification.ok).toBe(true);
    });

    it('construye el prompt de redacción contextual de forma estructurada', () => {
        const prompt = buildNarrativePrompt('¿Cuántas citas tuve?', 'Conteo de citas del mes', period, { total: 45 });
        expect(prompt).toContain('Eres un analista de negocios ejecutivo');
        expect(prompt).toContain('DATOS');
        expect(prompt).toContain('"total":45');
    });

    it('generateNarrative retorna la frase cuando el LLM responde válidamente y no alucina', async () => {
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
                text: 'En este periodo se captaron 45 prospectos en total.',
                inputTokens: 120,
                outputTokens: 25,
            }),
        };
        vi.spyOn(LlmProviderFactory, 'getProvider').mockReturnValue(mockProvider as any);

        const mockFastify = {
            log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
            supabaseAdmin: {},
        } as unknown as FastifyInstance;

        const narrative = await generateNarrative(mockFastify, 'org-123', {
            question: '¿Cuántos prospectos tuve?',
            interpretation: 'Conteo de prospectos',
            period,
            data: { total: 45 },
        });

        expect(narrative).toBe('En este periodo se captaron 45 prospectos en total.');
    });

    it('generateNarrative retorna null y loguea advertencia si la redacción alucina cifras', async () => {
        vi.spyOn(llmConfigService, 'getLlmConfig').mockResolvedValue({
            provider: 'openai',
            model: 'gpt-4o-mini',
            baseUrl: null,
            validatedAt: '2026-08-18T00:00:00Z',
            lastError: null,
        });
        vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-mock-key');

        const mockProvider = {
            complete: vi.fn().mockResolvedValue({
                text: 'Tuviste 45 prospectos pero 999 se dieron de baja.',
                inputTokens: 120,
                outputTokens: 25,
            }),
        };
        vi.spyOn(LlmProviderFactory, 'getProvider').mockReturnValue(mockProvider as any);

        const mockFastify = {
            log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
            supabaseAdmin: {},
        } as unknown as FastifyInstance;

        const narrative = await generateNarrative(mockFastify, 'org-123', {
            question: '¿Cuántos prospectos tuve?',
            interpretation: 'Conteo de prospectos',
            period,
            data: { total: 45 },
        });

        expect(narrative).toBeNull();
        expect(mockFastify.log.warn).toHaveBeenCalled();
    });
});
