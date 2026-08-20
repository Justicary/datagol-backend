import { describe, it, expect } from 'vitest';
import { extractCallSentiment } from '../src/services/call-sentiment.js';

describe('extractCallSentiment — Normalización y Extracción Robusta del Sentimiento', () => {
    describe('1. Evaluación directa de call_successful (polimórfico boolean / string)', () => {
        it('call_successful = true (boolean) → "Positivo"', () => {
            const result = extractCallSentiment({
                analysis: { call_successful: true },
            });
            expect(result).toBe('Positivo');
        });

        it('call_successful = false (boolean) → "Negativo"', () => {
            const result = extractCallSentiment({
                analysis: { call_successful: false },
            });
            expect(result).toBe('Negativo');
        });

        it('call_successful = "success" (string en minúsculas) → "Positivo"', () => {
            const result = extractCallSentiment({
                analysis: { call_successful: 'success' },
            });
            expect(result).toBe('Positivo');
        });

        it('call_successful = "SUCCESS" (string en mayúsculas / espacios) → "Positivo"', () => {
            const result = extractCallSentiment({
                analysis: { call_successful: '  SUCCESS  ' },
            });
            expect(result).toBe('Positivo');
        });

        it('call_successful = "true" (string) → "Positivo"', () => {
            const result = extractCallSentiment({
                analysis: { call_successful: 'true' },
            });
            expect(result).toBe('Positivo');
        });

        it('call_successful = "positivo" (string) → "Positivo"', () => {
            const result = extractCallSentiment({
                analysis: { call_successful: 'positivo' },
            });
            expect(result).toBe('Positivo');
        });

        it('call_successful = "failure" (string en minúsculas) → "Negativo"', () => {
            const result = extractCallSentiment({
                analysis: { call_successful: 'failure' },
            });
            expect(result).toBe('Negativo');
        });

        it('call_successful = "FAILURE" (string en mayúsculas) → "Negativo"', () => {
            const result = extractCallSentiment({
                analysis: { call_successful: 'FAILURE' },
            });
            expect(result).toBe('Negativo');
        });

        it('call_successful = "false" (string) → "Negativo"', () => {
            const result = extractCallSentiment({
                analysis: { call_successful: 'false' },
            });
            expect(result).toBe('Negativo');
        });

        it('call_successful = "negativo" (string) → "Negativo"', () => {
            const result = extractCallSentiment({
                analysis: { call_successful: 'negativo' },
            });
            expect(result).toBe('Negativo');
        });
    });

    describe('2. Inspección de evaluation_criteria_results (cuando call_successful es unknown o null)', () => {
        it('criterio con result = "success" → "Positivo"', () => {
            const result = extractCallSentiment({
                analysis: {
                    call_successful: 'unknown',
                    evaluation_criteria_results: {
                        cita_agendada: { result: 'success' },
                    },
                },
            });
            expect(result).toBe('Positivo');
        });

        it('criterio con result = "true" o booleano true → "Positivo"', () => {
            const result = extractCallSentiment({
                analysis: {
                    call_successful: null,
                    evaluation_criteria_results: {
                        cliente_satisfecho: { result: true },
                    },
                },
            });
            expect(result).toBe('Positivo');
        });

        it('criterio con valor escalar "success" → "Positivo"', () => {
            const result = extractCallSentiment({
                analysis: {
                    call_successful: null,
                    evaluation_criteria_results: {
                        interes_confirmado: 'success',
                    },
                },
            });
            expect(result).toBe('Positivo');
        });

        it('criterio con result = "failure" → "Negativo"', () => {
            const result = extractCallSentiment({
                analysis: {
                    call_successful: 'unknown',
                    evaluation_criteria_results: {
                        queja_no_resuelta: { result: 'failure' },
                    },
                },
            });
            expect(result).toBe('Negativo');
        });

        it('criterio con result = "false" o booleano false → "Negativo"', () => {
            const result = extractCallSentiment({
                analysis: {
                    call_successful: null,
                    evaluation_criteria_results: {
                        contacto_exitoso: { result: false },
                    },
                },
            });
            expect(result).toBe('Negativo');
        });

        it('criterio con valor escalar "failure" → "Negativo"', () => {
            const result = extractCallSentiment({
                analysis: {
                    call_successful: null,
                    evaluation_criteria_results: {
                        motivo_rechazo: 'failure',
                    },
                },
            });
            expect(result).toBe('Negativo');
        });
    });

    describe('3. Fallback inteligente ante latencia asíncrona / análisis ausente', () => {
        it('llamada real (>20s y >=2 turnos con contenido) sin fallo explícito → "Positivo"', () => {
            const result = extractCallSentiment({
                analysis: null,
                durationSeconds: 45,
                transcript: [
                    { role: 'agent', message: 'Hola, ¿en qué puedo ayudarte?' },
                    { role: 'user', message: 'Quiero información sobre sus paquetes.' },
                ],
            });
            expect(result).toBe('Positivo');
        });

        it('llamada real (>20s y >=2 turnos) cuando analysis está vacío → "Positivo"', () => {
            const result = extractCallSentiment({
                analysis: {},
                durationSeconds: 25,
                transcript: [
                    { role: 'agent', message: 'Buen día, clínica dental.' },
                    { role: 'user', message: 'Hola, quiero agendar una cita.' },
                    { role: 'agent', message: 'Con gusto, ¿qué día prefiere?' },
                ],
            });
            expect(result).toBe('Positivo');
        });

        it('llamada corta (<20s) sin análisis → "Neutral"', () => {
            const result = extractCallSentiment({
                analysis: null,
                durationSeconds: 12,
                transcript: [
                    { role: 'agent', message: 'Hola.' },
                    { role: 'user', message: 'Equivocado.' },
                ],
            });
            expect(result).toBe('Neutral');
        });

        it('llamada de >20s pero sin turnos o turnos con mensaje vacío → "Neutral"', () => {
            const result = extractCallSentiment({
                analysis: null,
                durationSeconds: 30,
                transcript: [
                    { role: 'agent', message: '' },
                    { role: 'user', message: '   ' },
                ],
            });
            expect(result).toBe('Neutral');
        });

        it('payload totalmente vacío / sin datos → "Neutral"', () => {
            const result = extractCallSentiment({});
            expect(result).toBe('Neutral');
        });
    });
});
