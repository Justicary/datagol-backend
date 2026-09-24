import { describe, it, expect, beforeEach, afterEach, vi, expectTypeOf } from 'vitest';
import {
    createJevDecision,
    JevRequestError,
    type JevQuestions,
} from '../src/services/jev/jev-decisions-client.js';

function mockResponse(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
}

// Mismo ejemplo que la documentación de OpenRouter para ~typesafe/jev-latest.
const QUESTIONS = {
    is_urgent: {
        type: 'noul',
        instructions: 'Does this message convey urgency?',
        criteria: { true: 'Explicitly time-sensitive', false: 'No urgency expressed' },
    },
    department: {
        type: 'choice',
        instructions: 'Which team should handle this?',
        criteria: {
            billing: 'Payments, invoicing, refunds',
            technical: 'Bugs, outages, integrations',
            sales: 'Pricing, upgrades, new accounts',
        },
    },
    frustration: {
        type: 'score',
        instructions: 'How frustrated is the customer?',
        criteria: ['Calm', 'Frustrated', 'Very angry'],
    },
} as const satisfies JevQuestions;

const OK_BODY = {
    id: 'dec_123',
    model: 'typesafe/jev-20260901',
    provider: 'TypeSafe',
    answers: {
        is_urgent: { type: 'noul', noul: 0.93 },
        department: { type: 'choice', choice: 'billing', confidence: 0.81, probabilities: { billing: 0.88, technical: 0.1, sales: 0.02 } },
        frustration: { type: 'score', score: 1.4, confidence: 0.7, probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 }, legend: { '0': 'Calm' } },
    },
    usage: { input_tokens: 120, output_tokens: 6, cost: 0.00004 },
};

const BASE = { apiKey: 'sk-or-jev', model: '~typesafe/jev-latest', state: 'Help! My payouts have been failing for 3 days.' };

describe('services/jev/jev-decisions-client.ts', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('éxito: POST /api/alpha/decisions con model/state/questions y devuelve respuestas tipadas y consumo', async () => {
        global.fetch = vi.fn().mockResolvedValue(mockResponse(200, OK_BODY));

        const result = await createJevDecision({ ...BASE, questions: QUESTIONS });

        const [url, init] = vi.mocked(global.fetch).mock.calls[0];
        expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
        expect(init?.method).toBe('POST');
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer sk-or-jev');
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers.Accept).toBe('application/json');
        expect(headers['HTTP-Referer']).toBe('https://datagol.net');
        expect(headers['X-OpenRouter-Title']).toBe('Datagol');
        expect(JSON.parse(init?.body as string)).toEqual({ model: BASE.model, state: BASE.state, questions: QUESTIONS });

        expect(result).toEqual({
            id: 'dec_123',
            model: 'typesafe/jev-20260901',
            answers: {
                is_urgent: { type: 'noul', noul: 0.93 },
                department: { type: 'choice', choice: 'billing', confidence: 0.81, probabilities: { billing: 0.88, technical: 0.1, sales: 0.02 } },
                frustration: { type: 'score', score: 1.4, confidence: 0.7, probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 } },
            },
            usage: { inputTokens: 120, outputTokens: 6, costUsd: 0.00004 },
        });

        // Las respuestas quedan tipadas por pregunta, sin castear en el llamador.
        expectTypeOf(result.answers.is_urgent.noul).toEqualTypeOf<number>();
        expectTypeOf(result.answers.department.choice).toEqualTypeOf<'billing' | 'technical' | 'sales'>();
        expectTypeOf(result.answers.frustration.score).toEqualTypeOf<number>();
    });

    it('acepta estado estructurado y campos opcionales ausentes (sin id, confidence, probabilities ni cost)', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            mockResponse(200, {
                model: 'm',
                answers: { department: { type: 'choice', choice: 'sales' } },
                usage: { input_tokens: 0, output_tokens: 0 },
            })
        );
        const state = { message: 'quiero precios', channel: 'whatsapp' };

        const result = await createJevDecision({ ...BASE, state, questions: { department: QUESTIONS.department } });

        expect(JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]?.body as string).state).toEqual(state);
        expect(result).toEqual({
            id: null,
            model: 'm',
            answers: { department: { type: 'choice', choice: 'sales', confidence: null, probabilities: {} } },
            usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
        });
    });

    it('score sin confidence/probabilities → null y {}', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            mockResponse(200, { model: 'm', answers: { frustration: { type: 'score', score: 2 } }, usage: { input_tokens: 1, output_tokens: 1 } })
        );
        const result = await createJevDecision({ ...BASE, questions: { frustration: QUESTIONS.frustration } });
        expect(result.answers.frustration).toEqual({ type: 'score', score: 2, confidence: null, probabilities: {} });
    });

    it('pasa el timeout propio a la petición (se aborta si Jev no responde)', async () => {
        vi.useFakeTimers();
        try {
            global.fetch = vi.fn(
                (_url: string | URL | Request, init?: RequestInit) =>
                    new Promise<Response>((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                    })
            ) as typeof global.fetch;
            const promise = createJevDecision({ ...BASE, questions: QUESTIONS, timeoutMs: 50 });
            const assertion = expect(promise).rejects.toMatchObject({ kind: 'network_error' });
            await vi.advanceTimersByTimeAsync(50);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    describe('validación de preguntas (no se envía nada si no cumplen el contrato)', () => {
        it.each([
            ['sin preguntas', {}],
            ['instrucciones vacías', { q: { type: 'noul', instructions: '  ' } }],
            ['choice con una sola opción', { q: { type: 'choice', instructions: 'x', criteria: { a: 'A' } } }],
            [
                'choice con más de 255 opciones',
                { q: { type: 'choice', instructions: 'x', criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, 'd'])) } },
            ],
            ['score con un nivel', { q: { type: 'score', instructions: 'x', criteria: ['uno'] } }],
            ['score con 11 niveles', { q: { type: 'score', instructions: 'x', criteria: Array.from({ length: 11 }, (_, i) => `n${i}`) } }],
            ['noul con criteria incompleto', { q: { type: 'noul', instructions: 'x', criteria: { true: 'sí' } } }],
        ])('%s → JevRequestError', async (_label, questions) => {
            global.fetch = vi.fn();
            await expect(createJevDecision({ ...BASE, questions: questions as JevQuestions })).rejects.toBeInstanceOf(JevRequestError);
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('el mensaje de JevRequestError enumera cada problema encontrado', async () => {
            global.fetch = vi.fn();
            const questions = {
                a: { type: 'noul', instructions: ' ' },
                b: { type: 'score', instructions: 'x', criteria: ['uno'] },
            } as unknown as JevQuestions;
            const error = await createJevDecision({ ...BASE, questions }).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(JevRequestError);
            expect((error as JevRequestError).name).toBe('JevRequestError');
            expect((error as JevRequestError).message).toMatch(/^Preguntas inválidas para Jev: .+; .+$/);
            expect((error as JevRequestError).message).not.toContain('undefined');
        });

        it('estado de texto vacío → JevRequestError', async () => {
            global.fetch = vi.fn();
            await expect(createJevDecision({ ...BASE, state: '   ', questions: QUESTIONS })).rejects.toThrow(
                'El estado a evaluar por Jev no puede estar vacío.'
            );
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('contraparte de éxito: los límites exactos (2 y 255 opciones, 2 y 10 niveles, noul sin criteria) sí se envían', async () => {
            global.fetch = vi.fn().mockResolvedValue(
                mockResponse(200, {
                    model: 'm',
                    answers: {
                        c2: { type: 'choice', choice: 'a' },
                        c255: { type: 'choice', choice: 'o0' },
                        s2: { type: 'score', score: 0 },
                        s10: { type: 'score', score: 9 },
                        n: { type: 'noul', noul: 0 },
                    },
                    usage: { input_tokens: 1, output_tokens: 1 },
                })
            );
            const questions = {
                c2: { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } },
                c255: { type: 'choice', instructions: 'x', criteria: Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`o${i}`, 'd'])) },
                s2: { type: 'score', instructions: 'x', criteria: ['bajo', 'alto'] },
                s10: { type: 'score', instructions: 'x', criteria: Array.from({ length: 10 }, (_, i) => `n${i}`) },
                n: { type: 'noul', instructions: 'x' },
            } satisfies JevQuestions;

            const result = await createJevDecision({ ...BASE, questions });

            expect(global.fetch).toHaveBeenCalledTimes(1);
            expect(result.answers.n).toEqual({ type: 'noul', noul: 0 });
        });
    });

    describe('validación de la respuesta contra lo preguntado', () => {
        it.each([
            ['falta una respuesta', { is_urgent: OK_BODY.answers.is_urgent, department: OK_BODY.answers.department }],
            ['tipo distinto al preguntado', { ...OK_BODY.answers, is_urgent: { type: 'score', score: 1 } }],
            ['opción que no existe en criteria', { ...OK_BODY.answers, department: { type: 'choice', choice: 'legal' } }],
            ['opción heredada de Object.prototype', { ...OK_BODY.answers, department: { type: 'choice', choice: 'toString' } }],
            ['noul fuera de [0, 1]', { ...OK_BODY.answers, is_urgent: { type: 'noul', noul: 1.2 } }],
            ['probabilidad fuera de [0, 1]', { ...OK_BODY.answers, department: { type: 'choice', choice: 'billing', probabilities: { billing: 2 } } }],
            ['tipo desconocido', { ...OK_BODY.answers, frustration: { type: 'ranking', order: [] } }],
        ])('%s → kind unknown', async (_label, answers) => {
            global.fetch = vi.fn().mockResolvedValue(mockResponse(200, { ...OK_BODY, answers }));
            await expect(createJevDecision({ ...BASE, questions: QUESTIONS })).rejects.toMatchObject({ kind: 'unknown' });
        });

        it('mensaje interno nombra la pregunta con problema', async () => {
            global.fetch = vi.fn().mockResolvedValue(
                mockResponse(200, { ...OK_BODY, answers: { ...OK_BODY.answers, department: { type: 'choice', choice: 'legal' } } })
            );
            await expect(createJevDecision({ ...BASE, questions: QUESTIONS })).rejects.toMatchObject({
                providerMessage: 'La opción "legal" no existe en la pregunta "department"',
            });
        });

        it('mensaje interno cuando falta la respuesta', async () => {
            global.fetch = vi.fn().mockResolvedValue(mockResponse(200, { ...OK_BODY, answers: {} }));
            await expect(createJevDecision({ ...BASE, questions: QUESTIONS })).rejects.toMatchObject({
                providerMessage: 'Respuesta ausente o de tipo incorrecto para la pregunta "is_urgent"',
            });
        });

        it('respuestas extra de preguntas no hechas se ignoran (incluso de tipo desconocido)', async () => {
            global.fetch = vi.fn().mockResolvedValue(
                mockResponse(200, { ...OK_BODY, answers: { ...OK_BODY.answers, extra: { type: 'ranking' } } })
            );
            const result = await createJevDecision({ ...BASE, questions: QUESTIONS });
            expect(Object.keys(result.answers).sort()).toEqual(['department', 'frustration', 'is_urgent']);
        });

        it.each([
            ['sin usage', { model: 'm', answers: OK_BODY.answers }],
            ['sin model', { answers: OK_BODY.answers, usage: OK_BODY.usage }],
            ['tokens negativos', { ...OK_BODY, usage: { input_tokens: -1, output_tokens: 0 } }],
            ['cuerpo vacío', ''],
        ])('respuesta 200 %s → unknown', async (_label, body) => {
            global.fetch = vi.fn().mockResolvedValue(mockResponse(200, body));
            await expect(createJevDecision({ ...BASE, questions: QUESTIONS })).rejects.toMatchObject({
                kind: 'unknown',
                providerMessage: 'Respuesta de /api/alpha/decisions sin el formato esperado',
            });
        });
    });

    describe('errores del proveedor', () => {
        it.each([
            [401, 'invalid_key'],
            [403, 'invalid_key'],
            [402, 'no_credit'],
            [404, 'model_not_found'],
            [408, 'network_error'],
            [429, 'network_error'],
            [500, 'network_error'],
            [502, 'network_error'],
            [524, 'network_error'],
            [529, 'network_error'],
            [400, 'unknown'],
            [413, 'unknown'],
        ])('status %i → kind %s, con el mensaje crudo solo en providerMessage', async (status, kind) => {
            global.fetch = vi.fn().mockResolvedValue(mockResponse(status, { error: { message: 'detalle crudo' } }));
            await expect(createJevDecision({ ...BASE, questions: QUESTIONS })).rejects.toMatchObject({ kind, providerMessage: 'detalle crudo' });
        });

        it('error con cuerpo no-JSON → se clasifica por status', async () => {
            global.fetch = vi.fn().mockResolvedValue(mockResponse(503, '<html>down</html>'));
            await expect(createJevDecision({ ...BASE, questions: QUESTIONS })).rejects.toMatchObject({
                kind: 'network_error',
                providerMessage: undefined,
            });
        });

        it('fallo de red (fetch lanza) → network_error', async () => {
            global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
            await expect(createJevDecision({ ...BASE, questions: QUESTIONS })).rejects.toMatchObject({ kind: 'network_error' });
        });
    });
});
