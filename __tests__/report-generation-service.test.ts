import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateReportNarrative, verifyNarrativeNumbers } from '../src/services/report-generation-service.js';
import * as secretService from '../src/services/secret-service.js';
import * as llmConfigService from '../src/services/llm-config-service.js';
import { LlmProviderFactory } from '../src/services/llm/LlmProviderFactory.js';
import { REPORT_TYPES } from '../src/types/reports.js';
import type { PlanningReportData } from '../src/services/report-data-service.js';

const EMPTY_PLANNING_DATA: PlanningReportData = {
    weekStart: '2026-08-10',
    weekEnd: '2026-08-16',
    appointmentsByDay: [],
    unconfirmedAppointments: [],
    hotLeadsPending: [],
    overdueFollowups: [],
    stalledContacts: [],
    dailyLoad: [],
    agendaGapsMinutes: null,
};

const ACTIVE_PLANNING_DATA: PlanningReportData = {
    ...EMPTY_PLANNING_DATA,
    hotLeadsPending: [
        {
            lead_id: 'lead-1',
            full_name: 'Juan Pérez',
            phone_e164: '+525512345678',
            business_name: null,
            inquiry_reason: 'Cotización de servicio',
            created_at: '2026-08-11T10:00:00.000Z',
        },
    ],
    unconfirmedAppointments: [{ id: 'appt-1', customer_name: 'María López', start_time: '2026-08-12T15:00:00.000Z' }],
};

function fakeFastify() {
    return { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any;
}

describe('services/report-generation-service.ts', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('verifyNarrativeNumbers', () => {
        it('acepta números pequeños (≤12) sin importar si están en los datos', () => {
            const result = verifyNarrativeNumbers('Aquí van 3 recomendaciones y 2 alertas.', EMPTY_PLANNING_DATA);
            expect(result.ok).toBe(true);
        });

        it('acepta números incrustados en fechas/teléfonos de los datos (no son cifras inventadas)', () => {
            const result = verifyNarrativeNumbers(
                'El prospecto con teléfono 525512345678 contactó el 11 de agosto de 2026.',
                ACTIVE_PLANNING_DATA
            );
            expect(result.ok).toBe(true);
        });

        it('rechaza un número grande que no aparece en ningún lado de los datos', () => {
            const result = verifyNarrativeNumbers('Se registraron 458 llamadas esta semana.', ACTIVE_PLANNING_DATA);
            expect(result.ok).toBe(false);
            expect(result.unmatched).toContain(458);
        });
    });

    describe('generateReportNarrative', () => {
        it('semana sin actividad: no llama al LLM, usa mensaje fijo', async () => {
            const fastify = fakeFastify();
            const getProviderSpy = vi.spyOn(LlmProviderFactory, 'getProvider');

            const result = await generateReportNarrative(fastify, 'org-1', REPORT_TYPES.PLANNING, EMPTY_PLANNING_DATA);

            expect(result.usedFallback).toBe(false);
            expect(result.narrative).toContain('no hubo actividad');
            expect(getProviderSpy).not.toHaveBeenCalled();
        });

        it('contraparte de éxito: con actividad, llave y config válidas, genera narrativa y registra el consumo', async () => {
            const fastify = fakeFastify();
            vi.spyOn(llmConfigService, 'getLlmConfig').mockResolvedValue({
                provider: 'openrouter',
                model: 'deepseek/deepseek-v4-flash-0731',
                baseUrl: 'https://openrouter.ai/api/v1',
                validatedAt: '2026-08-01T00:00:00.000Z',
                lastError: null,
            });
            vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-or-real');
            const recordUsageSpy = vi.spyOn(llmConfigService, 'recordLlmUsage').mockResolvedValue(undefined);
            vi.spyOn(LlmProviderFactory, 'getProvider').mockReturnValue({
                complete: vi.fn().mockResolvedValue({
                    text: JSON.stringify({
                        narrative: 'Esta semana hay 1 prospecto caliente sin atender y 1 cita sin confirmar.',
                        recommendations: ['Llamar a Juan Pérez lo antes posible.'],
                    }),
                    inputTokens: 50,
                    outputTokens: 20,
                }),
            });

            const result = await generateReportNarrative(fastify, 'org-1', REPORT_TYPES.PLANNING, ACTIVE_PLANNING_DATA);

            expect(result.usedFallback).toBe(false);
            expect(result.narrative).toContain('prospecto caliente');
            expect(result.recommendations).toHaveLength(1);
            expect(recordUsageSpy).toHaveBeenCalledOnce();
        });

        it('sin configuración de LLM: cae a fallback sin llamar al proveedor', async () => {
            const fastify = fakeFastify();
            vi.spyOn(llmConfigService, 'getLlmConfig').mockResolvedValue({
                provider: null,
                model: null,
                baseUrl: null,
                validatedAt: null,
                lastError: null,
            });
            const getProviderSpy = vi.spyOn(LlmProviderFactory, 'getProvider');

            const result = await generateReportNarrative(fastify, 'org-1', REPORT_TYPES.PLANNING, ACTIVE_PLANNING_DATA);

            expect(result.usedFallback).toBe(true);
            expect(result.narrative).toBeNull();
            expect(getProviderSpy).not.toHaveBeenCalled();
        });

        it('respuesta no-JSON en ambos intentos: cae a fallback tras 2 intentos', async () => {
            const fastify = fakeFastify();
            vi.spyOn(llmConfigService, 'getLlmConfig').mockResolvedValue({
                provider: 'openai',
                model: 'gpt-4o-mini',
                baseUrl: null,
                validatedAt: '2026-08-01T00:00:00.000Z',
                lastError: null,
            });
            vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-real');
            const completeMock = vi.fn().mockResolvedValue({ text: 'esto no es JSON', inputTokens: 10, outputTokens: 5 });
            vi.spyOn(LlmProviderFactory, 'getProvider').mockReturnValue({ complete: completeMock });

            const result = await generateReportNarrative(fastify, 'org-1', REPORT_TYPES.PLANNING, ACTIVE_PLANNING_DATA);

            expect(result.usedFallback).toBe(true);
            expect(result.narrative).toBeNull();
            expect(completeMock).toHaveBeenCalledTimes(2);
        });

        it('cifra inventada en ambos intentos: se descarta y cae a fallback tras 2 intentos', async () => {
            const fastify = fakeFastify();
            vi.spyOn(llmConfigService, 'getLlmConfig').mockResolvedValue({
                provider: 'openai',
                model: 'gpt-4o-mini',
                baseUrl: null,
                validatedAt: '2026-08-01T00:00:00.000Z',
                lastError: null,
            });
            vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-real');
            const completeMock = vi.fn().mockResolvedValue({
                text: JSON.stringify({ narrative: 'Se registraron 999 llamadas esta semana, un récord.', recommendations: [] }),
                inputTokens: 10,
                outputTokens: 5,
            });
            vi.spyOn(LlmProviderFactory, 'getProvider').mockReturnValue({ complete: completeMock });
            const recordUsageSpy = vi.spyOn(llmConfigService, 'recordLlmUsage').mockResolvedValue(undefined);

            const result = await generateReportNarrative(fastify, 'org-1', REPORT_TYPES.PLANNING, ACTIVE_PLANNING_DATA);

            expect(result.usedFallback).toBe(true);
            expect(completeMock).toHaveBeenCalledTimes(2);
            expect(recordUsageSpy).not.toHaveBeenCalled();
        });
    });
});
