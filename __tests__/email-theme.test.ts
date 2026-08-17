import { describe, it, expect } from 'vitest';
import {
    parseColorToSolidHex,
    getContrastRatio,
    ensureContrastAgainstWhite,
    deriveSafeEmailTheme,
    DEFAULT_DATAGOL_EMAIL_THEME,
} from '../src/services/email-theme.js';

describe('FASE A — Derivación de tema seguro para correos (email-theme.ts)', () => {
    describe('parseColorToSolidHex', () => {
        it('convierte rgba(18, 18, 23, 0.75) a hex sólido mezclado sobre blanco', () => {
            const hex = parseColorToSolidHex('rgba(18, 18, 23, 0.75)');
            expect(hex).toBeDefined();
            expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
            // 18 * 0.75 + 255 * 0.25 = 13.5 + 63.75 = 77.25 -> 77 (0x4d)
            // 23 * 0.75 + 255 * 0.25 = 17.25 + 63.75 = 81 (0x51)
            expect(hex).toBe('#4d4d51');
        });

        it('convierte rgb(37, 99, 235) a hex sólido #2563eb', () => {
            const hex = parseColorToSolidHex('rgb(37, 99, 235)');
            expect(hex).toBe('#2563eb');
        });

        it('expande formato corto #RGB (#09b -> #0099bb)', () => {
            const hex = parseColorToSolidHex('#09b');
            expect(hex).toBe('#0099bb');
        });

        it('preserva formato estándar #RRGGBB en minúsculas', () => {
            const hex = parseColorToSolidHex('#2563EB');
            expect(hex).toBe('#2563eb');
        });

        it('convierte hex de 8 caracteres con alfa #RRGGBBAA mezclándolo sobre blanco', () => {
            const hex = parseColorToSolidHex('#12121780'); // ~50% alfa
            expect(hex).toBeDefined();
            expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
        });

        it('devuelve null si el valor es inválido, vacío o no es string', () => {
            expect(parseColorToSolidHex('color-invalido')).toBeNull();
            expect(parseColorToSolidHex('')).toBeNull();
            expect(parseColorToSolidHex(null)).toBeNull();
            expect(parseColorToSolidHex(undefined)).toBeNull();
            expect(parseColorToSolidHex(12345)).toBeNull();
        });
    });

    describe('Cálculo de contraste WCAG y ensureContrastAgainstWhite', () => {
        it('calcula ratio de contraste correcto para blanco sobre negro (21:1)', () => {
            const ratio = getContrastRatio('#ffffff', '#000000');
            expect(ratio).toBeCloseTo(21, 0);
        });

        it('calcula ratio de contraste 1:1 para colores idénticos', () => {
            const ratio = getContrastRatio('#ffffff', '#ffffff');
            expect(ratio).toBeCloseTo(1, 1);
        });

        it('corrige acentos de bajo contraste (ej. amarillo #ffff00 o #facc15) para alcanzar ≥ 4.5:1', () => {
            const yellow = '#facc15';
            const initialRatio = getContrastRatio(yellow, '#ffffff');
            expect(initialRatio).toBeLessThan(4.5);

            const corrected = ensureContrastAgainstWhite(yellow, 4.5);
            const finalRatio = getContrastRatio(corrected, '#ffffff');
            expect(finalRatio).toBeGreaterThanOrEqual(4.5);
        });

        it('preserva acentos que ya tienen alto contraste (ej. azul oscuro #1e3a8a)', () => {
            const darkBlue = '#1e3a8a';
            const initialRatio = getContrastRatio(darkBlue, '#ffffff');
            expect(initialRatio).toBeGreaterThanOrEqual(4.5);

            const result = ensureContrastAgainstWhite(darkBlue, 4.5);
            expect(result).toBe(darkBlue);
        });
    });

    describe('deriveSafeEmailTheme', () => {
        it('tema ausente, null o vacío produce la paleta segura por defecto completa', () => {
            const themeNull = deriveSafeEmailTheme(null);
            expect(themeNull).toEqual(DEFAULT_DATAGOL_EMAIL_THEME);

            const themeUndefined = deriveSafeEmailTheme(undefined);
            expect(themeUndefined).toEqual(DEFAULT_DATAGOL_EMAIL_THEME);

            const themeEmpty = deriveSafeEmailTheme({});
            expect(themeEmpty).toEqual(DEFAULT_DATAGOL_EMAIL_THEME);
        });

        it('deriva accent y accentSecondary desde accentColor en formato rgba', () => {
            const theme = deriveSafeEmailTheme({
                accentColor: 'rgba(18, 18, 23, 0.75)',
                accentSecondary: '#10b981',
            });

            expect(theme.accent).toBe('#4d4d51');
            expect(theme.accentSecondary).toBe('#10b981');
            expect(theme.background).toBe('#ffffff');
            expect(theme.canvas).toBe('#f4f6f8');
            expect(theme.text).toBe('#1f2937');
        });

        it('ignora propiedades de pantalla (background oscuro, border, typography, surface)', () => {
            const theme = deriveSafeEmailTheme({
                accentColor: '#3b82f6',
                background: '#09090b',
                surface: 'rgba(18, 18, 23, 0.75)',
                border: '#27272a',
                typography: 'var(--font-sans)',
            });

            expect(theme.accent).toBe('#3b82f6');
            // Fondo siempre blanco en correo
            expect(theme.background).toBe('#ffffff');
            expect(theme.canvas).toBe('#f4f6f8');
            expect(theme.text).toBe('#1f2937');
            expect(theme.border).toBe('#e5e7eb');
        });

        it('corrige acento amarillo para que el texto sea legible (≥ 4.5:1)', () => {
            const theme = deriveSafeEmailTheme({
                accentColor: '#facc15', // Amarillo brillante
            });

            expect(theme.accent).toBe('#facc15'); // Conserva el acento puro para fondos
            expect(getContrastRatio(theme.accentText, '#ffffff')).toBeGreaterThanOrEqual(4.5);
        });

        it('acento inválido no rompe la ejecución y usa default', () => {
            const theme = deriveSafeEmailTheme({
                accentColor: 'no-es-color-valido',
            });

            expect(theme.accent).toBe(DEFAULT_DATAGOL_EMAIL_THEME.accent);
            expect(theme.accentText).toBe(DEFAULT_DATAGOL_EMAIL_THEME.accentText);
        });
    });
});
