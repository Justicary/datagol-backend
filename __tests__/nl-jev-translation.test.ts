import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
    tryTranslateWithJev,
    JEV_NL_MIN_CONFIDENCE,
    JEV_NL_FILTER_THRESHOLD,
    JEV_NL_TIMEOUT_MS,
} from '../src/services/reports/nl-jev-translation.js';
import { translateQuestion } from '../src/services/reports/nl-translation-service.js';
import * as jevConfigService from '../src/services/jev-config-service.js';
import * as jevDecisionService from '../src/services/jev-decision-service.js';
import * as llmConfigService from '../src/services/llm-config-service.js';
import * as secretService from '../src/services/secret-service.js';
import { LlmProviderFactory } from '../src/services/llm/LlmProviderFactory.js';
import { ALL_INTENTS } from '../src/services/reports/intents/index.js';
import { createJevDecision, type JevQuestions } from '../src/services/jev/jev-decisions-client.js';

type Answers = Record<string, unknown>;

function choice(value: string, confidence: number | null = 0.9, probabilities: Record<string, number> = {}) {
    return { type: 'choice', choice: value, confidence, probabilities };
}

function answers(overrides: Partial<Record<'intencion' | 'periodo' | 'comparar_con' | 'menciona_filtro', unknown>> = {}): Answers {
    return {
        intencion: choice('conteo_prospectos_nuevos'),
        periodo: choice('mes_pasado'),
        comparar_con: choice('ninguna'),
        menciona_filtro: { type: 'noul', noul: 0.1 },
        ...overrides,
    };
}

function mockJev(result: Answers | { ok: false; reason: string }) {
    vi.spyOn(jevConfigService, 'isJevConfigValidated').mockResolvedValue(true);
    return vi.spyOn(jevDecisionService, 'evaluateJevDecision').mockResolvedValue(
        ('ok' in result
            ? result
            : { ok: true, answers: result, model: 'typesafe/jev', usage: { inputTokens: 1, outputTokens: 1, costUsd: null } }) as never
    );
}

function buildFastify() {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { fastify: { log, supabaseAdmin: {} } as unknown as FastifyInstance, log };
}

describe('services/reports/nl-jev-translation.ts — tryTranslateWithJev', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('sin Jev validado → fallback jev_no_configurado, sin llamar a Jev', async () => {
        const { fastify } = buildFastify();
        const validatedSpy = vi.spyOn(jevConfigService, 'isJevConfigValidated').mockResolvedValue(false);
        const evaluateSpy = vi.spyOn(jevDecisionService, 'evaluateJevDecision');

        const attempt = await tryTranslateWithJev(fastify, 'org-1', '¿Cuántos prospectos nuevos tuve?');

        expect(attempt).toEqual({ status: 'fallback', reason: 'jev_no_configurado' });
        expect(validatedSpy).toHaveBeenCalledWith(fastify, 'org-1');
        expect(evaluateSpy).not.toHaveBeenCalled();
    });

    it('éxito: pregunta la intención, periodo, comparación y filtro sobre la pregunta, con timeout propio', async () => {
        const { fastify } = buildFastify();
        const evaluateSpy = mockJev(answers());

        const attempt = await tryTranslateWithJev(fastify, 'org-1', '¿Cuántos prospectos nuevos tuve el mes pasado?');

        expect(attempt).toEqual({
            status: 'resolved',
            confidence: 0.9,
            result: {
                status: 'success',
                intent: 'conteo_prospectos_nuevos',
                parameters: { periodo: { type: 'mes_pasado' } },
                interpretation: 'Conteo prospectos nuevos, mes pasado',
            },
        });

        const [calledFastify, orgId, params] = evaluateSpy.mock.calls[0];
        expect(calledFastify).toBe(fastify);
        expect(orgId).toBe('org-1');
        expect(params.state).toEqual({ pregunta: '¿Cuántos prospectos nuevos tuve el mes pasado?' });
        expect(params.timeoutMs).toBe(JEV_NL_TIMEOUT_MS);
        expect(JEV_NL_TIMEOUT_MS).toBe(3000);

        const questions = params.questions as Record<string, { type: string; criteria?: Record<string, string> }>;
        expect(Object.keys(questions).sort()).toEqual(['comparar_con', 'intencion', 'menciona_filtro', 'periodo']);
        const intentOptions = Object.keys(questions.intencion.criteria ?? {});
        expect(intentOptions).toEqual([...ALL_INTENTS.map((i) => i.key), 'fuera_de_catalogo', 'ambigua']);
        const firstIntent = ALL_INTENTS[0];
        expect(questions.intencion.criteria?.[firstIntent.key]).toBe(
            `${firstIntent.description} Ejemplos: ${firstIntent.examples.map((e) => `"${e}"`).join(', ')}`
        );
        expect(Object.keys(questions.periodo.criteria ?? {})).toEqual([
            'hoy', 'ayer', 'esta_semana', 'semana_pasada', 'este_mes', 'mes_pasado', 'ultimos_n_dias', 'rango_explicito', 'sin_periodo',
        ]);
        expect(Object.keys(questions.comparar_con.criteria ?? {})).toEqual(['ninguna', 'periodo_anterior', 'mismo_periodo_mes_pasado']);
        expect(questions.menciona_filtro.type).toBe('noul');
    });

    it('las preguntas enviadas a Jev: tipos, instrucciones y opciones extra exactas', async () => {
        const { fastify } = buildFastify();
        const evaluateSpy = mockJev(answers());
        await tryTranslateWithJev(fastify, 'org-1', 'q');
        const questions = evaluateSpy.mock.calls[0][2].questions as Record<string, { type: string; instructions: string; criteria?: Record<string, string> }>;

        expect(questions.intencion.type).toBe('choice');
        expect(questions.intencion.instructions).toBe('¿Qué reporte de negocio pide la pregunta del usuario?');
        expect(questions.intencion.criteria?.fuera_de_catalogo).toBe(
            'Pide algo que ninguna otra opción cubre (pipeline detallado, nómina, inventario, configuración técnica de IA).'
        );
        expect(questions.intencion.criteria?.ambigua).toBe('Pregunta vaga, sin un tema claro (¿cómo voy?, ¿está bien?, ¿qué pasó?).');
        expect(questions.periodo).toMatchObject({ type: 'choice', instructions: '¿A qué periodo de tiempo se refiere la pregunta?' });
        expect(questions.periodo.criteria?.sin_periodo).toBe('No menciona ningún periodo de tiempo');
        expect(questions.comparar_con).toMatchObject({
            type: 'choice',
            instructions: '¿La pregunta pide comparar el resultado contra otro periodo?',
        });
        expect(questions.menciona_filtro).toEqual({
            type: 'noul',
            instructions:
                '¿La pregunta restringe el resultado con un filtro o límite concreto (un estado como confirmadas o canceladas, un canal como WhatsApp o llamada, una cantidad como "los últimos 5", o solo los no leídos)?',
            criteria: { true: 'Menciona un filtro o límite concreto', false: 'No restringe el resultado' },
        });
    });

    it('las preguntas cumplen el contrato del cliente de Jev (se envían sin JevRequestError)', async () => {
        const { fastify } = buildFastify();
        const evaluateSpy = mockJev(answers());
        await tryTranslateWithJev(fastify, 'org-1', 'q');
        const questions = evaluateSpy.mock.calls[0][2].questions as JevQuestions;

        const originalFetch = global.fetch;
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: () =>
                Promise.resolve(
                    JSON.stringify({
                        model: 'm',
                        answers: {
                            intencion: { type: 'choice', choice: 'costo_total' },
                            periodo: { type: 'choice', choice: 'hoy' },
                            comparar_con: { type: 'choice', choice: 'ninguna' },
                            menciona_filtro: { type: 'noul', noul: 0 },
                        },
                        usage: { input_tokens: 1, output_tokens: 1 },
                    })
                ),
        } as unknown as Response);
        try {
            await expect(createJevDecision({ apiKey: 'k', model: 'm', state: { pregunta: 'q' }, questions })).resolves.toBeDefined();
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('una opción que no es intención del catálogo → fallback intencion_fuera_de_catalogo', async () => {
        const { fastify } = buildFastify();
        mockJev(answers({ intencion: choice('intencion_inventada', 0.99) }));
        expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toEqual({ status: 'fallback', reason: 'intencion_fuera_de_catalogo' });
    });

    it('periodo y comparación justo en el umbral de confianza → resuelve', async () => {
        const { fastify } = buildFastify();
        mockJev(answers({ periodo: choice('hoy', 0.7), comparar_con: choice('ninguna', 0.7) }));
        expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toMatchObject({ status: 'resolved' });
    });

    it.each([
        ['hoy', 'hoy'],
        ['ayer', 'ayer'],
        ['esta_semana', 'esta semana'],
        ['semana_pasada', 'semana pasada'],
        ['este_mes', 'este mes'],
    ])('periodo %s se acepta y se describe como "%s"', async (period, label) => {
        const { fastify } = buildFastify();
        mockJev(answers({ intencion: choice('costo_total'), periodo: choice(period) }));
        const attempt = await tryTranslateWithJev(fastify, 'org-1', 'q');
        expect(attempt).toMatchObject({
            status: 'resolved',
            result: { intent: 'costo_total', parameters: { periodo: { type: period } }, interpretation: `Costo total, ${label}` },
        });
    });

    it('sin periodo en la pregunta → este_mes (mismo default que el prompt del LLM)', async () => {
        const { fastify } = buildFastify();
        mockJev(answers({ periodo: choice('sin_periodo') }));
        const attempt = await tryTranslateWithJev(fastify, 'org-1', 'q');
        expect(attempt).toMatchObject({ status: 'resolved', result: { parameters: { periodo: { type: 'este_mes' } } } });
    });

    it.each(['periodo_anterior', 'mismo_periodo_mes_pasado'])('comparar_con %s se pasa como parámetro', async (comparison) => {
        const { fastify } = buildFastify();
        mockJev(answers({ comparar_con: choice(comparison) }));
        const attempt = await tryTranslateWithJev(fastify, 'org-1', 'q');
        expect(attempt).toMatchObject({
            status: 'resolved',
            result: { parameters: { periodo: { type: 'mes_pasado' }, comparar_con: comparison } },
        });
    });

    it('Jev falla → fallback jev_fallo con el motivo', async () => {
        const { fastify } = buildFastify();
        mockJev({ ok: false, reason: 'network_error' });
        expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toEqual({ status: 'fallback', reason: 'jev_fallo', detail: 'network_error' });
    });

    it('error inesperado → fallback jev_fallo y queda en el log', async () => {
        const { fastify, log } = buildFastify();
        vi.spyOn(jevConfigService, 'isJevConfigValidated').mockRejectedValue(new Error('boom'));
        expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toEqual({
            status: 'fallback',
            reason: 'jev_fallo',
            detail: 'error_inesperado',
        });
        expect(log.warn).toHaveBeenCalledWith({ organizationId: 'org-1', err: 'boom' }, '[NlTranslation] Error inesperado en el camino de Jev');
    });

    it.each([
        ['fuera_de_catalogo', 'intencion_fuera_de_catalogo'],
        ['ambigua', 'pregunta_ambigua'],
    ])('intención %s → fallback %s (el LLM redacta la respuesta)', async (value, reason) => {
        const { fastify } = buildFastify();
        mockJev(answers({ intencion: choice(value, 0.99) }));
        expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toEqual({ status: 'fallback', reason });
    });

    it('confianza de la intención justo bajo el umbral → fallback; en el umbral → resuelve', async () => {
        const { fastify } = buildFastify();
        expect(JEV_NL_MIN_CONFIDENCE).toBe(0.7);
        mockJev(answers({ intencion: choice('costo_total', 0.69) }));
        expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toEqual({
            status: 'fallback',
            reason: 'intencion_baja_confianza',
            detail: '0.69',
        });

        vi.restoreAllMocks();
        mockJev(answers({ intencion: choice('costo_total', 0.7) }));
        expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toMatchObject({ status: 'resolved', confidence: 0.7 });
    });

    it('sin confidence usa la probabilidad de la opción elegida; sin ninguna, confianza 0', async () => {
        const { fastify } = buildFastify();
        mockJev(answers({ intencion: choice('costo_total', null, { costo_total: 0.8 }) }));
        expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toMatchObject({ status: 'resolved', confidence: 0.8 });

        vi.restoreAllMocks();
        mockJev(answers({ intencion: choice('costo_total', null, {}) }));
        expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toMatchObject({ status: 'fallback', reason: 'intencion_baja_confianza', detail: '0' });
    });

    describe('filtros que Jev no puede extraer', () => {
        it.each(['conteo_citas', 'listado_citas', 'conteo_conversaciones', 'listado_correos_enviados', 'resumen_correos_recibidos'])(
            'intención con parámetros propios (%s) + filtro en el umbral → fallback requiere_filtro',
            async (intent) => {
                const { fastify } = buildFastify();
                expect(JEV_NL_FILTER_THRESHOLD).toBe(0.5);
                mockJev(answers({ intencion: choice(intent), menciona_filtro: { type: 'noul', noul: 0.5 } }));
                expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toEqual({ status: 'fallback', reason: 'requiere_filtro', detail: '0.5' });
            }
        );

        it('contraparte: intención con parámetros sin filtro (0.49) → resuelve sin parámetros propios', async () => {
            const { fastify } = buildFastify();
            mockJev(answers({ intencion: choice('conteo_citas'), menciona_filtro: { type: 'noul', noul: 0.49 } }));
            expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toMatchObject({
                status: 'resolved',
                result: { intent: 'conteo_citas', parameters: { periodo: { type: 'mes_pasado' } } },
            });
        });

        it('intención SIN parámetros propios ignora el filtro (no hay nada que extraer)', async () => {
            const { fastify } = buildFastify();
            mockJev(answers({ intencion: choice('costo_total'), menciona_filtro: { type: 'noul', noul: 0.95 } }));
            expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toMatchObject({ status: 'resolved' });
        });
    });

    it.each(['ultimos_n_dias', 'rango_explicito'])('periodo %s lleva valores que Jev no extrae → fallback', async (period) => {
        const { fastify } = buildFastify();
        mockJev(answers({ periodo: choice(period) }));
        expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toEqual({ status: 'fallback', reason: 'periodo_con_valores', detail: period });
    });

    it('periodo con baja confianza → fallback', async () => {
        const { fastify } = buildFastify();
        mockJev(answers({ periodo: choice('mes_pasado', 0.5) }));
        expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toEqual({ status: 'fallback', reason: 'periodo_baja_confianza' });
    });

    it('comparación con baja confianza → fallback', async () => {
        const { fastify } = buildFastify();
        mockJev(answers({ comparar_con: choice('ninguna', 0.5) }));
        expect(await tryTranslateWithJev(fastify, 'org-1', 'q')).toEqual({ status: 'fallback', reason: 'comparacion_baja_confianza' });
    });
});

describe('translateQuestion con Jev como camino rápido opcional', () => {
    const LLM_JSON = {
        status: 'success',
        intent: 'costo_total',
        parameters: { periodo: { type: 'ultimos_n_dias', n: 7 } },
        interpretation: 'Costo total, últimos 7 días',
    };
    let completeSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.spyOn(llmConfigService, 'getLlmConfig').mockResolvedValue({
            provider: 'openai',
            model: 'gpt-4o-mini',
            baseUrl: null,
            validatedAt: '2026-08-18T00:00:00Z',
            lastError: null,
        });
        vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-mock');
        vi.spyOn(llmConfigService, 'recordLlmUsage').mockResolvedValue();
        completeSpy = vi.fn().mockResolvedValue({ text: JSON.stringify(LLM_JSON), inputTokens: 10, outputTokens: 5 });
        vi.spyOn(LlmProviderFactory, 'getProvider').mockReturnValue({ complete: completeSpy } as never);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('Jev resuelve → devuelve su traducción sin llamar al LLM y lo registra', async () => {
        const { fastify, log } = buildFastify();
        mockJev(answers());

        const result = await translateQuestion(fastify, 'org-1', { question: '¿Cuántos prospectos nuevos tuve el mes pasado?' });

        expect(result).toEqual({
            status: 'success',
            intent: 'conteo_prospectos_nuevos',
            parameters: { periodo: { type: 'mes_pasado' } },
            interpretation: 'Conteo prospectos nuevos, mes pasado',
        });
        expect(completeSpy).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith(
            { organizationId: 'org-1', path: 'jev', intent: 'conteo_prospectos_nuevos', confidence: 0.9 },
            '[NlTranslation] Pregunta traducida con Jev'
        );
    });

    it('Jev no resuelve → el LLM traduce como antes y se registra el motivo', async () => {
        const { fastify, log } = buildFastify();
        mockJev(answers({ periodo: choice('ultimos_n_dias') }));

        const result = await translateQuestion(fastify, 'org-1', { question: '¿Cuánto gasté en los últimos 7 días?' });

        expect(completeSpy).toHaveBeenCalledTimes(1);
        expect(result).toEqual(LLM_JSON);
        expect(log.info).toHaveBeenCalledWith(
            { organizationId: 'org-1', path: 'llm', jevFallbackReason: 'periodo_con_valores', detail: 'ultimos_n_dias' },
            '[NlTranslation] Jev no resolvió la pregunta, se traduce con el LLM'
        );
    });

    it('organización sin Jev → el LLM traduce sin registrar un fallback de Jev', async () => {
        const { fastify, log } = buildFastify();
        vi.spyOn(jevConfigService, 'isJevConfigValidated').mockResolvedValue(false);

        const result = await translateQuestion(fastify, 'org-1', { question: 'q' });

        expect(result).toEqual(LLM_JSON);
        expect(completeSpy).toHaveBeenCalledTimes(1);
        expect(log.info).not.toHaveBeenCalled();
    });

    it('sin LLM configurado ni siquiera se intenta Jev: el LLM es obligatorio', async () => {
        const { fastify } = buildFastify();
        vi.mocked(llmConfigService.getLlmConfig).mockResolvedValue({
            provider: null,
            model: null,
            baseUrl: null,
            validatedAt: null,
            lastError: null,
        });
        const validatedSpy = vi.spyOn(jevConfigService, 'isJevConfigValidated');
        const evaluateSpy = vi.spyOn(jevDecisionService, 'evaluateJevDecision');

        const result = await translateQuestion(fastify, 'org-1', { question: 'q' });

        expect(result.status).toBe('no_resuelta');
        expect(validatedSpy).not.toHaveBeenCalled();
        expect(evaluateSpy).not.toHaveBeenCalled();
    });

    it('sin llave de LLM tampoco se intenta Jev', async () => {
        const { fastify } = buildFastify();
        vi.mocked(secretService.getSecret).mockResolvedValue(null);
        const evaluateSpy = vi.spyOn(jevDecisionService, 'evaluateJevDecision');

        const result = await translateQuestion(fastify, 'org-1', { question: 'q' });

        expect(result.status).toBe('no_resuelta');
        expect(evaluateSpy).not.toHaveBeenCalled();
    });
});
