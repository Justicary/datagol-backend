import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    askReport,
    checkRateLimits,
    clearReportCaches,
    NaturalReportsError,
} from '../src/services/reports/nl-reports-service.js';
import * as entitlements from '../src/services/entitlements.js';
import * as llmConfigService from '../src/services/llm-config-service.js';
import * as translationService from '../src/services/reports/nl-translation-service.js';
import * as narrativeService from '../src/services/reports/nl-narrative-service.js';
import * as unansweredService from '../src/services/reports/unanswered-questions-service.js';
import { FastifyInstance } from 'fastify';

describe('services/reports/nl-reports-service.ts — Orquestador de Reportes en Lenguaje Natural', () => {
    const orgId = 'org-test-uuid';
    const userId = 'user-test-uuid';

    beforeEach(() => {
        vi.restoreAllMocks();
        clearReportCaches();
    });

    it('controla límites de tasa por minuto y por día', () => {
        // 10 consultas por minuto por usuario
        for (let i = 0; i < 10; i++) {
            const check = checkRateLimits(orgId, userId, 100);
            expect(check.ok).toBe(true);
        }
        // Consulta 11 en el mismo minuto debe ser rechazada
        const rejectedMinute = checkRateLimits(orgId, userId, 100);
        expect(rejectedMinute.ok).toBe(false);
        expect(rejectedMinute.message).toContain('límite de 10 consultas por minuto');
    });

    it('rechaza con 403 si la feature natural_language_reports no está habilitada', async () => {
        vi.spyOn(entitlements, 'isFeatureEnabled').mockResolvedValue(false);

        const mockFastify = {} as FastifyInstance;

        await expect(
            askReport(mockFastify, orgId, { question: '¿cuántas citas hay?', userId })
        ).rejects.toThrow(NaturalReportsError);
    });

    it('rechaza con 403 si la llave de LLM BYOK no está validada', async () => {
        vi.spyOn(entitlements, 'isFeatureEnabled').mockResolvedValue(true);
        vi.spyOn(llmConfigService, 'isLlmConfigValidated').mockResolvedValue(false);

        const mockFastify = {} as FastifyInstance;

        await expect(
            askReport(mockFastify, orgId, { question: '¿cuántas citas hay?', userId })
        ).rejects.toThrow(NaturalReportsError);
    });

    it('ejecuta exitosamente el flujo completo y cachea la respuesta para consultas repetidas', async () => {
        vi.spyOn(entitlements, 'isFeatureEnabled').mockResolvedValue(true);
        vi.spyOn(llmConfigService, 'isLlmConfigValidated').mockResolvedValue(true);

        const mockQueryBuilder: any = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            gte: vi.fn().mockReturnThis(),
            lte: vi.fn().mockReturnThis(),
            lt: vi.fn().mockReturnThis(),
            is: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            maybeSingle: vi.fn().mockResolvedValue({ data: { timezone: 'America/Mexico_City', integration_settings: {} } }),
            then: vi.fn().mockImplementation((cb) => cb({ data: [], count: 25, error: null })),
        };

        const mockFastify = {
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            supabaseAdmin: {
                from: vi.fn().mockReturnValue(mockQueryBuilder),
            },
        } as unknown as FastifyInstance;

        vi.spyOn(translationService, 'translateQuestion').mockResolvedValue({
            status: 'success',
            intent: 'conteo_citas',
            parameters: { periodo: { type: 'este_mes' } },
            interpretation: 'Conteo de citas del mes actual',
        });

        vi.spyOn(narrativeService, 'generateNarrative').mockResolvedValue(
            'En este mes se registraron 25 citas en total.'
        );

        // 1. Primera llamada: ejecuta LLM y query
        const firstResponse = await askReport(mockFastify, orgId, {
            question: '¿Cuántas citas se han agendado este mes?',
            userId,
        });

        expect(firstResponse.status).toBe('success');
        if (firstResponse.status === 'success') {
            expect(firstResponse.intent).toBe('conteo_citas');
            expect(firstResponse.narrative).toBe('En este mes se registraron 25 citas en total.');
            expect((firstResponse.data as any).total).toBe(25);
            expect(firstResponse.cached).toBeFalsy();
        }

        // 2. Segunda llamada con la misma pregunta: debe servirse de caché
        const secondResponse = await askReport(mockFastify, orgId, {
            question: '¿Cuántas citas se han agendado este mes?',
            userId,
        });

        expect(secondResponse.status).toBe('success');
        if (secondResponse.status === 'success') {
            expect(secondResponse.cached).toBe(true);
        }
    });

    it('registra en unanswered_questions cuando la pregunta requiere aclaración', async () => {
        vi.spyOn(entitlements, 'isFeatureEnabled').mockResolvedValue(true);
        vi.spyOn(llmConfigService, 'isLlmConfigValidated').mockResolvedValue(true);

        const recordSpy = vi.spyOn(unansweredService, 'recordUnansweredQuestion').mockResolvedValue();

        const mockQueryBuilder: any = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { timezone: 'America/Mexico_City' } }),
        };

        const mockFastify = {
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            supabaseAdmin: {
                from: vi.fn().mockReturnValue(mockQueryBuilder),
            },
        } as unknown as FastifyInstance;

        vi.spyOn(translationService, 'translateQuestion').mockResolvedValue({
            status: 'requiere_aclaracion',
            preguntaAclaracion: '¿Te refieres a citas o a llamadas?',
            interpretation: 'Pregunta ambigua',
        });

        const response = await askReport(mockFastify, orgId, {
            question: '¿qué pasó?',
            userId,
        });

        expect(response.status).toBe('requiere_aclaracion');
        expect(recordSpy).toHaveBeenCalledWith(
            mockFastify,
            expect.objectContaining({
                organizationId: orgId,
                reason: 'requiere_aclaracion',
                question: '¿qué pasó?',
            })
        );
    });
});
