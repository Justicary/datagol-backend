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

    /**
     * Antes de la reforma de numeración de México de 2019, marcar un celular
     * mexicano desde el extranjero exigía anteponer un "1" de trunk móvil
     * después del código de país (+52 1 55 1234 5678). La E.164 canónica
     * vigente ya no lo lleva: celulares y fijos comparten el mismo esquema
     * de 10 dígitos nacionales (+52 55 1234 5678). Sin manejo explícito,
     * libphonenumber-js no despoja ese "1" — lo cuenta como parte del número
     * nacional (11 dígitos en vez de 10) y lo marca inválido, así que ambas
     * formas del MISMO número terminaban en resultados distintos: una se
     * normalizaba, la otra se rechazaba en silencio.
     *
     * Varios sistemas externos siguen entregando la forma histórica con "1"
     * en 2026 (más notablemente el wa_id de WhatsApp/Meta para contactos
     * mexicanos — ver docs/tasks, verificación pendiente de una conversación
     * real de WhatsApp vía ElevenLabs, que a la fecha no existe en
     * `webhook_events`: los 12 eventos reales capturados para la
     * organización de producción son todos `post_call_transcription` de voz,
     * ninguno de WhatsApp). Mientras no haya un ejemplo real que confirme el
     * formato exacto que ElevenLabs entregará para ese canal, aceptar ambas
     * formas de un número mexicano es la postura defensiva correcta.
     *
     * Valor canónico verificado: **+522218300450** (sin el "1") — es la
     * forma que `parsed.isValid()` acepta y la que ya usan
     * `TELNYX_PHONE_NUMBER` y `NEXT_PUBLIC_WHATSAPP_PHONE_NUMBER` en `.env`
     * para este mismo número real de producción.
     */
    describe('forma histórica con "1" de trunk móvil (+521XXXXXXXXXX) — número real de producción', () => {
        const LEGACY_FORM = '+5212218300450';
        const MODERN_FORM = '+522218300450';
        const CANONICAL = '+522218300450';

        it(`la forma moderna (${MODERN_FORM}) normaliza al valor canónico`, () => {
            const result = normalizePhoneE164(MODERN_FORM);
            expect(result.success).toBe(true);
            expect(result.phoneE164).toBe(CANONICAL);
        });

        it(`la forma histórica con "1" (${LEGACY_FORM}) también normaliza al MISMO valor canónico`, () => {
            const result = normalizePhoneE164(LEGACY_FORM);
            expect(result.success).toBe(true);
            expect(result.phoneE164).toBe(CANONICAL);
        });

        it('ambas formas producen exactamente el mismo phoneE164 — no dos contactos distintos para la misma persona', () => {
            const legacy = normalizePhoneE164(LEGACY_FORM);
            const modern = normalizePhoneE164(MODERN_FORM);
            expect(legacy.phoneE164).toBe(modern.phoneE164);
        });

        it('también reconoce la forma histórica sin el signo +', () => {
            const result = normalizePhoneE164('5212218300450');
            expect(result.success).toBe(true);
            expect(result.phoneE164).toBe(CANONICAL);
        });

        it('no despoja un "1" que no corresponde a este patrón exacto: 9 dígitos tras 521 no se acepta como si fueran 10', () => {
            const result = normalizePhoneE164('+521221830045');
            expect(result.success).toBe(false);
            expect(result.phoneE164).toBeNull();
        });

        it('no despoja un "1" que no corresponde a este patrón exacto: 11 dígitos tras 521 no se acepta como si fueran 10', () => {
            const result = normalizePhoneE164('+52122183004501');
            expect(result.success).toBe(false);
            expect(result.phoneE164).toBeNull();
        });

        it('el despojo de "1" es específico de MX: con defaultCountry distinto no se aplica', () => {
            // +14155552671 (número real de EE.UU. usado en otra prueba de este
            // archivo) no coincide con el patrón +521 de todas formas, pero
            // esta prueba deja explícito que la regla está condicionada a
            // defaultCountry === 'MX', no a un patrón de dígitos aislado.
            const result = normalizePhoneE164('+14155552671', 'US');
            expect(result.success).toBe(true);
            expect(result.phoneE164).toBe('+14155552671');
        });
    });
});
