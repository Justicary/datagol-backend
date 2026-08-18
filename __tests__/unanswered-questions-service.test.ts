import { describe, it, expect, vi } from 'vitest';
import {
    recordUnansweredQuestion,
    listUnansweredQuestions,
    getUnansweredQuestionsSummary,
} from '../src/services/reports/unanswered-questions-service.js';
import { FastifyInstance } from 'fastify';

describe('services/reports/unanswered-questions-service.ts', () => {
    it('inserta una pregunta no resuelta en la base de datos', async () => {
        const insertSpy = vi.fn().mockResolvedValue({ error: null });
        const mockFastify = {
            supabaseAdmin: {
                from: vi.fn().mockReturnValue({
                    insert: insertSpy,
                }),
            },
            log: { error: vi.fn(), warn: vi.fn() },
        } as unknown as FastifyInstance;

        await recordUnansweredQuestion(mockFastify, {
            organizationId: 'org-1',
            question: '¿cuántas ventas tuve?',
            reason: 'requiere_aclaracion',
            metadata: { intent: null },
        });

        expect(insertSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                organization_id: 'org-1',
                question: '¿cuántas ventas tuve?',
                reason: 'requiere_aclaracion',
            })
        );
    });

    it('lista preguntas no resueltas aplicando filtros opcionales de organización y razón', async () => {
        const mockRows = [
            { id: 'q1', organization_id: 'org-1', question: 'p1', reason: 'no_resuelta', created_at: '2026-08-18' },
        ];

        const queryBuilder: any = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: mockRows, error: null }),
        };

        const mockFastify = {
            supabaseAdmin: {
                from: vi.fn().mockReturnValue(queryBuilder),
            },
            log: { error: vi.fn(), warn: vi.fn() },
        } as unknown as FastifyInstance;

        const results = await listUnansweredQuestions(mockFastify, {
            organizationId: 'org-1',
            reason: 'no_resuelta',
            limit: 10,
        });

        expect(results).toEqual(mockRows);
        expect(queryBuilder.eq).toHaveBeenCalledWith('organization_id', 'org-1');
        expect(queryBuilder.eq).toHaveBeenCalledWith('reason', 'no_resuelta');
    });

    it('calcula el resumen agrupado de preguntas no resueltas para guiar la v2', async () => {
        const mockRows = [
            { question: '¿cómo voy?', reason: 'requiere_aclaracion' },
            { question: '¿cómo voy?', reason: 'requiere_aclaracion' },
            { question: '¿cuántas devoluciones hubo?', reason: 'no_resuelta' },
        ];

        const queryBuilder: any = {
            select: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: mockRows, error: null }),
        };

        const mockFastify = {
            supabaseAdmin: {
                from: vi.fn().mockReturnValue(queryBuilder),
            },
            log: { error: vi.fn(), warn: vi.fn() },
        } as unknown as FastifyInstance;

        const summary = await getUnansweredQuestionsSummary(mockFastify, 100);
        expect(summary.total).toBe(3);
        expect(summary.porRazon.requiere_aclaracion).toBe(2);
        expect(summary.porRazon.no_resuelta).toBe(1);
        expect(summary.preguntasFrecuentes[0]).toEqual({
            question: '¿cómo voy?',
            total: 2,
            reason: 'requiere_aclaracion',
        });
    });
});
