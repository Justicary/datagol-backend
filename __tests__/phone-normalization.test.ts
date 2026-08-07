import { describe, it, expect } from 'vitest';
import { normalizePhoneE164 } from '../src/services/phone-normalization.js';

/**
 * Fase 6 — prueba obligatoria de AGENTS.md/backend-implementation.md:
 * "Normalización E.164: números en formatos diversos se normalizan; un
 * número inválido no aborta el procesamiento del lead."
 *
 * Esta suite cubre la parte de normalización en sí (contraparte de éxito
 * incluida); la parte de "no aborta el procesamiento" se ejercita end-to-end
 * en __tests__/process-call-completed-rpc.test.ts, donde un
 * `p_caller_phone_e164` nulo sigue produciendo un lead insertado.
 */
describe('normalizePhoneE164', () => {
    it('normaliza un número local mexicano a 10 dígitos usando MX como país por defecto', () => {
        const result = normalizePhoneE164('2221234567');
        expect(result.success).toBe(true);
        expect(result.phoneE164).toBe('+522221234567');
    });

    it('normaliza un número que ya viene en formato E.164', () => {
        const result = normalizePhoneE164('+522221234567');
        expect(result.success).toBe(true);
        expect(result.phoneE164).toBe('+522221234567');
    });

    it('normaliza un número con espacios, guiones y paréntesis', () => {
        const result = normalizePhoneE164('(222) 123-4567');
        expect(result.success).toBe(true);
        expect(result.phoneE164).toBe('+522221234567');
    });

    it('normaliza un número con código de país explícito distinto al default (US)', () => {
        const result = normalizePhoneE164('+14155552671');
        expect(result.success).toBe(true);
        expect(result.phoneE164).toBe('+14155552671');
    });

    it('respeta un defaultCountry distinto cuando se pasa explícitamente', () => {
        const result = normalizePhoneE164('4155552671', 'US');
        expect(result.success).toBe(true);
        expect(result.phoneE164).toBe('+14155552671');
    });

    it('contraparte de rechazo: un número con muy pocos dígitos no se normaliza, pero no lanza excepción', () => {
        const result = normalizePhoneE164('123');
        expect(result.success).toBe(false);
        expect(result.phoneE164).toBeNull();
        expect(result.error).toBeTruthy();
    });

    it('contraparte de rechazo: una cadena no numérica no se normaliza y no lanza excepción', () => {
        const result = normalizePhoneE164('no soy un teléfono');
        expect(result.success).toBe(false);
        expect(result.phoneE164).toBeNull();
    });

    it('un número vacío o nulo se reporta como fallo explícito, sin lanzar excepción', () => {
        expect(normalizePhoneE164('').success).toBe(false);
        expect(normalizePhoneE164(null).success).toBe(false);
        expect(normalizePhoneE164(undefined).success).toBe(false);
    });

    it('conserva el input crudo original en el resultado, tanto en éxito como en fallo', () => {
        expect(normalizePhoneE164('  2221234567  ').rawInput).toBe('2221234567');
        expect(normalizePhoneE164('abc').rawInput).toBe('abc');
    });
});
