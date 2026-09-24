import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { evaluateJevDecision } from '../src/services/jev-decision-service.js';
import * as secretService from '../src/services/secret-service.js';
import * as rateService from '../src/services/rate-service.js';
import * as decisionsClient from '../src/services/jev/jev-decisions-client.js';
import { JevRequestError, type JevQuestions } from '../src/services/jev/jev-decisions-client.js';
import { LlmProviderError, type LlmProviderErrorKind } from '../src/services/llm/llm-provider.interface.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';

const QUESTIONS = {
    is_urgent: { type: 'noul', instructions: '¿El mensaje es urgente?' },
} as const satisfies JevQuestions;

const DECISION = {
    id: 'dec_1',
    model: 'typesafe/jev-20260901',
    answers: { is_urgent: { type: 'noul' as const, noul: 0.9 } },
    usage: { inputTokens: 100, outputTokens: 4, costUsd: 0.00003 },
};

function buildFakeFastify(options: { jev?: Record<string, unknown>; insertError?: { message: string } | null; insertThrows?: boolean } = {}) {
    const usageInserts: Record<string, unknown>[] = [];
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fastify = {
        log,
        supabaseAdmin: {
            from: vi.fn((table: string) => {
                if (table === 'organizations') {
                    return {
                        select: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                maybeSingle: vi.fn().mockResolvedValue({
                                    data: { integration_settings: options.jev ? { jev: options.jev } : {} },
                                    error: null,
                                }),
                            }),
                        }),
                    };
                }
                if (table === 'usage_events') {
                    return {
                        insert: vi.fn((rows: Record<string, unknown>[]) => {
                            if (options.insertThrows) throw new Error('conexión perdida');
                            usageInserts.push(...rows);
                            return Promise.resolve({ error: options.insertError ?? null });
                        }),
                    };
                }
                return {};
            }),
        },
    } as unknown as FastifyInstance;
    return { fastify, log, usageInserts };
}

const CONFIGURED = { jev: { model: '~typesafe/jev-latest', validatedAt: '2026-09-24T00:00:00.000Z', lastError: null } };

describe('services/jev-decision-service.ts', () => {
    beforeEach(() => {
        vi.spyOn(rateService, 'getRate').mockResolvedValue({ unitRateUsd: 0 } as never);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('not_configured sin modelo: no consulta Vault ni llama a Jev', async () => {
        const { fastify } = buildFakeFastify();
        const getSecretSpy = vi.spyOn(secretService, 'getSecret');
        const clientSpy = vi.spyOn(decisionsClient, 'createJevDecision');

        const outcome = await evaluateJevDecision(fastify, 'org-1', { state: 'hola', questions: QUESTIONS });

        expect(outcome).toEqual({ ok: false, reason: 'not_configured' });
        expect(getSecretSpy).not.toHaveBeenCalled();
        expect(clientSpy).not.toHaveBeenCalled();
    });

    it('not_configured sin llave jev_api_key: no llama a Jev', async () => {
        const { fastify } = buildFakeFastify(CONFIGURED);
        const getSecretSpy = vi.spyOn(secretService, 'getSecret').mockResolvedValue(null);
        const clientSpy = vi.spyOn(decisionsClient, 'createJevDecision');

        const outcome = await evaluateJevDecision(fastify, 'org-1', { state: 'hola', questions: QUESTIONS });

        expect(outcome).toEqual({ ok: false, reason: 'not_configured' });
        expect(getSecretSpy).toHaveBeenCalledWith('org-1', SECRET_KEYS.JEV_API_KEY);
        expect(clientSpy).not.toHaveBeenCalled();
    });

    it('éxito: llama a Jev con la llave y el modelo de la organización, devuelve respuestas y registra consumo', async () => {
        const { fastify, log, usageInserts } = buildFakeFastify(CONFIGURED);
        vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-or-jev');
        const clientSpy = vi.spyOn(decisionsClient, 'createJevDecision').mockResolvedValue(DECISION);
        const rateSpy = vi.mocked(rateService.getRate).mockResolvedValue({ unitRateUsd: 0.000001 } as never);

        const outcome = await evaluateJevDecision(fastify, 'org-1', { state: { msg: 'urgente' }, questions: QUESTIONS, timeoutMs: 1500 });

        expect(clientSpy).toHaveBeenCalledWith({
            apiKey: 'sk-or-jev',
            model: '~typesafe/jev-latest',
            state: { msg: 'urgente' },
            questions: QUESTIONS,
            timeoutMs: 1500,
        });
        expect(outcome).toEqual({ ok: true, answers: DECISION.answers, model: DECISION.model, usage: DECISION.usage });
        expect(rateSpy).toHaveBeenCalledWith(fastify, 'jev', 'jev_input_token', expect.any(Date));
        expect(rateSpy).toHaveBeenCalledWith(fastify, 'jev', 'jev_output_token', expect.any(Date));

        const occurredAt = usageInserts[0].occurred_at;
        expect(typeof occurredAt).toBe('string');
        expect(usageInserts).toEqual([
            {
                organization_id: 'org-1',
                provider: 'jev',
                unit_type: 'jev_input_token',
                quantity: 100,
                unit_rate_usd: 0.000001,
                occurred_at: occurredAt,
                metadata: { model: DECISION.model, decision_id: 'dec_1', questions: ['is_urgent'], provider_cost_usd: 0.00003 },
            },
            {
                organization_id: 'org-1',
                provider: 'jev',
                unit_type: 'jev_output_token',
                quantity: 4,
                unit_rate_usd: 0.000001,
                occurred_at: occurredAt,
                metadata: { model: DECISION.model, decision_id: 'dec_1', questions: ['is_urgent'] },
            },
        ]);
        expect(log.warn).not.toHaveBeenCalled();
        // amount_usd es columna generada en Postgres: enviarla hace fallar el insert.
        for (const row of usageInserts) expect(row).not.toHaveProperty('amount_usd');
    });

    it('sin tarifa vigente registra con tarifa 0; sin tokens no inserta nada', async () => {
        const { fastify, usageInserts } = buildFakeFastify(CONFIGURED);
        vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-or-jev');
        vi.mocked(rateService.getRate).mockResolvedValue(null);
        vi.spyOn(decisionsClient, 'createJevDecision').mockResolvedValueOnce({ ...DECISION, usage: { inputTokens: 10, outputTokens: 0, costUsd: null } });

        await evaluateJevDecision(fastify, 'org-1', { state: 'x', questions: QUESTIONS });
        expect(usageInserts).toHaveLength(1);
        expect(usageInserts[0]).toMatchObject({ unit_type: 'jev_input_token', unit_rate_usd: 0 });

        const insertSpy = vi.mocked(fastify.supabaseAdmin.from);
        insertSpy.mockClear();
        vi.spyOn(decisionsClient, 'createJevDecision').mockResolvedValueOnce({ ...DECISION, usage: { inputTokens: 0, outputTokens: 0, costUsd: null } });
        const outcome = await evaluateJevDecision(fastify, 'org-1', { state: 'x', questions: QUESTIONS });
        expect(outcome.ok).toBe(true);
        expect(insertSpy).not.toHaveBeenCalledWith('usage_events');
    });

    it.each([
        ['el insert devuelve error', { insertError: { message: 'check violation' } }],
        ['el insert lanza', { insertThrows: true }],
    ])('un fallo de metering (%s) no invalida la decisión y queda en el log', async (_label, opts) => {
        const { fastify, log } = buildFakeFastify({ ...CONFIGURED, ...opts });
        vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-or-jev');
        vi.spyOn(decisionsClient, 'createJevDecision').mockResolvedValue(DECISION);

        const outcome = await evaluateJevDecision(fastify, 'org-1', { state: 'x', questions: QUESTIONS });

        expect(outcome.ok).toBe(true);
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: 'org-1' }),
            '[JevDecision] Falló el registro de consumo en usage_events'
        );
    });

    const kinds: LlmProviderErrorKind[] = ['invalid_key', 'no_credit', 'model_not_found', 'network_error', 'unknown'];
    it.each(kinds)('fallo del proveedor %s → { ok: false, reason } sin lanzar ni registrar consumo', async (kind) => {
        const { fastify, log, usageInserts } = buildFakeFastify(CONFIGURED);
        vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-or-jev');
        vi.spyOn(decisionsClient, 'createJevDecision').mockRejectedValue(new LlmProviderError(kind, 'crudo'));

        const outcome = await evaluateJevDecision(fastify, 'org-1', { state: 'x', questions: QUESTIONS });

        expect(outcome).toEqual({ ok: false, reason: kind });
        expect(usageInserts).toEqual([]);
        expect(log.warn).toHaveBeenCalledWith(
            { organizationId: 'org-1', kind, providerMessage: 'crudo' },
            '[JevDecision] Falló la evaluación con Jev'
        );
    });

    it('un error inesperado se reporta como unknown', async () => {
        const { fastify, log } = buildFakeFastify(CONFIGURED);
        vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-or-jev');
        vi.spyOn(decisionsClient, 'createJevDecision').mockRejectedValue(new Error('inesperado'));

        const outcome = await evaluateJevDecision(fastify, 'org-1', { state: 'x', questions: QUESTIONS });

        expect(outcome).toEqual({ ok: false, reason: 'unknown' });
        expect(log.warn).toHaveBeenCalledWith(
            { organizationId: 'org-1', kind: 'unknown', providerMessage: 'inesperado' },
            '[JevDecision] Falló la evaluación con Jev'
        );
    });

    it('preguntas inválidas → invalid_request, registrado como error', async () => {
        const { fastify, log } = buildFakeFastify(CONFIGURED);
        vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-or-jev');
        vi.spyOn(decisionsClient, 'createJevDecision').mockRejectedValue(new JevRequestError('Se requiere al menos una pregunta.'));

        const outcome = await evaluateJevDecision(fastify, 'org-1', { state: 'x', questions: {} });

        expect(outcome).toEqual({ ok: false, reason: 'invalid_request' });
        expect(log.error).toHaveBeenCalledWith(
            { organizationId: 'org-1', err: 'Se requiere al menos una pregunta.' },
            '[JevDecision] Preguntas inválidas, no se llamó a Jev'
        );
    });
});
