import { describe, it, expect } from 'vitest';
import {
    numberToSpanishWords,
    amountToSpokenSpanish,
    amountToLegalSpanish,
} from '../src/lib/number-to-spanish-words.js';
import { numberToSpanishWords as reExportedFromPlans } from '../src/services/plans-prompt-formatter.js';

describe('src/lib/number-to-spanish-words.ts', () => {
    describe('numberToSpanishWords y re-exportación en plans-prompt-formatter.ts', () => {
        it('re-exporta la misma función desde plans-prompt-formatter.ts', () => {
            expect(reExportedFromPlans).toBe(numberToSpanishWords);
        });

        it.each([
            [0, 'cero'],
            [1, 'un'],
            [2, 'dos'],
            [3, 'tres'],
            [4, 'cuatro'],
            [5, 'cinco'],
            [6, 'seis'],
            [7, 'siete'],
            [8, 'ocho'],
            [9, 'nueve'],
            [10, 'diez'],
            [11, 'once'],
            [12, 'doce'],
            [13, 'trece'],
            [14, 'catorce'],
            [15, 'quince'],
            [16, 'dieciséis'],
            [17, 'diecisiete'],
            [18, 'dieciocho'],
            [19, 'diecinueve'],
            [20, 'veinte'],
            [21, 'veintiun'],
            [22, 'veintidos'],
            [29, 'veintinueve'],
            [30, 'treinta'],
            [31, 'treinta y un'],
            [42, 'cuarenta y dos'],
            [53, 'cincuenta y tres'],
            [64, 'sesenta y cuatro'],
            [75, 'setenta y cinco'],
            [86, 'ochenta y seis'],
            [97, 'noventa y siete'],
            [100, 'cien'],
            [101, 'ciento un'],
            [115, 'ciento quince'],
            [200, 'doscientos'],
            [300, 'trescientos'],
            [400, 'cuatrocientos'],
            [500, 'quinientos'],
            [600, 'seiscientos'],
            [700, 'setecientos'],
            [800, 'ochocientos'],
            [999, 'novecientos noventa y nueve'],
            [1000, 'mil'],
            [1001, 'mil un'],
            [2000, 'dos mil'],
            [2499, 'dos mil cuatrocientos noventa y nueve'],
            [21000, 'veintiun mil'],
            [100000, 'cien mil'],
            [1000000, 'un millón'],
            [1000001, 'un millón un'],
            [2000000, 'dos millones'],
            [2500000, 'dos millones quinientos mil'],
            [-45, 'cuarenta y cinco'],
            [1_000_000_000, '1000000000'],
        ])('convierte %d a "%s"', (input, expected) => {
            expect(numberToSpanishWords(input)).toBe(expected);
        });
    });

    describe('amountToSpokenSpanish', () => {
        it('formatea cero, singular, plural, millones redondos y centavos en MXN, USD y EUR', () => {
            expect(amountToSpokenSpanish(0, 'MXN')).toBe('cero pesos');
            expect(amountToSpokenSpanish(100, 'MXN')).toBe('un peso');
            expect(amountToSpokenSpanish(200, 'MXN')).toBe('dos pesos');
            expect(amountToSpokenSpanish(2100, 'MXN')).toBe('veintiun pesos');
            expect(amountToSpokenSpanish(10000, 'MXN')).toBe('cien pesos');
            expect(amountToSpokenSpanish(100000, 'MXN')).toBe('mil pesos');
            expect(amountToSpokenSpanish(100000000, 'MXN')).toBe('un millón de pesos');
            expect(amountToSpokenSpanish(200000000, 'MXN')).toBe('dos millones de pesos');
            expect(amountToSpokenSpanish(100000100, 'MXN')).toBe('un millón un pesos');
            expect(amountToSpokenSpanish(185050, 'MXN')).toBe('mil ochocientos cincuenta pesos con cincuenta centavos');
            expect(amountToSpokenSpanish(185001, 'MXN')).toBe('mil ochocientos cincuenta pesos con un centavo');

            expect(amountToSpokenSpanish(100, 'USD')).toBe('un dólar');
            expect(amountToSpokenSpanish(250, 'USD')).toBe('dos dólares con cincuenta centavos');
            expect(amountToSpokenSpanish(100000000, 'USD')).toBe('un millón de dólares');

            expect(amountToSpokenSpanish(100, 'EUR')).toBe('un euro');
            expect(amountToSpokenSpanish(200, 'EUR')).toBe('dos euros');
            expect(amountToSpokenSpanish(100000000, 'EUR')).toBe('un millón de euros');

            // Moneda por defecto MXN y moneda desconocida usa código
            expect(amountToSpokenSpanish(500)).toBe('cinco pesos');
            expect(amountToSpokenSpanish(500, 'CAD')).toBe('cinco CAD');
        });
    });

    describe('amountToLegalSpanish', () => {
        it('formatea importes legales con centavos XX/100 y sufijo de moneda', () => {
            expect(amountToLegalSpanish(0, 'MXN')).toBe('(CERO PESOS 00/100 M.N.)');
            expect(amountToLegalSpanish(100, 'MXN')).toBe('(UN PESO 00/100 M.N.)');
            expect(amountToLegalSpanish(2100, 'MXN')).toBe('(VEINTIUN PESOS 00/100 M.N.)');
            expect(amountToLegalSpanish(185050, 'MXN')).toBe('(MIL OCHOCIENTOS CINCUENTA PESOS 50/100 M.N.)');
            expect(amountToLegalSpanish(185005, 'MXN')).toBe('(MIL OCHOCIENTOS CINCUENTA PESOS 05/100 M.N.)');
            expect(amountToLegalSpanish(100000000, 'MXN')).toBe('(UN MILLÓN DE PESOS 00/100 M.N.)');
            expect(amountToLegalSpanish(200000000, 'MXN')).toBe('(DOS MILLONES DE PESOS 00/100 M.N.)');

            expect(amountToLegalSpanish(100, 'USD')).toBe('(UN DÓLAR 00/100 USD)');
            expect(amountToLegalSpanish(185050, 'USD')).toBe('(MIL OCHOCIENTOS CINCUENTA DÓLARES 50/100 USD)');

            expect(amountToLegalSpanish(100, 'EUR')).toBe('(UN EURO 00/100 EUR)');
            expect(amountToLegalSpanish(200, 'EUR')).toBe('(DOS EUROS 00/100 EUR)');

            expect(amountToLegalSpanish(1000)).toBe('(DIEZ PESOS 00/100 M.N.)');
            expect(amountToLegalSpanish(1000, 'CAD')).toBe('(DIEZ CAD 00/100 CAD)');
        });
    });
});
