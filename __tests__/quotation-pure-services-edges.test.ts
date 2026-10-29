import { describe, it, expect } from 'vitest';
import {
    calculateQuotationTotals,
    QuotationMathError,
    type QuotationLineInput,
} from '../src/services/quotations/quotation-math.js';
import { formatFolio, FolioFormatError } from '../src/services/quotations/quotation-folio.js';
import { buildCartSpokenSummary } from '../src/services/quotations/quotation-cart-summary.js';
import { computeValidUntilDate, isValidUntilExpired } from '../src/services/quotations/quotation-validity.js';
import { amountToSpokenSpanish, numberToSpanishWords } from '../src/lib/number-to-spanish-words.js';

/**
 * Bordes de los servicios puros de cotización (categoría cálculo de costos,
 * mutación ≥ 90 %): límites de validación, mensajes de error verbalizables,
 * normalización de moneda y frases del resumen hablado. Cada rechazo tiene su
 * contraparte aceptada en el mismo límite.
 */

function line(overrides: Partial<QuotationLineInput> = {}): QuotationLineInput {
    return {
        sku: 'SKU-1',
        productName: 'Producto',
        itemType: 'producto',
        billingPeriod: 'unico',
        quantity: 1,
        unitPrice: 100,
        currency: 'MXN',
        priceIncludesTax: false,
        taxRate: 0.16,
        ...overrides,
    };
}

function captureMathError(items: QuotationLineInput[]): QuotationMathError {
    try {
        calculateQuotationTotals(items);
    } catch (err) {
        if (err instanceof QuotationMathError) return err;
        throw err;
    }
    throw new Error('Se esperaba QuotationMathError');
}

describe('calculateQuotationTotals — bordes de validación', () => {
    it('carrito vacío: error tipado con código, nombre y mensaje verbalizable', () => {
        const err = captureMathError([]);
        expect(err.name).toBe('QuotationMathError');
        expect(err.code).toBe('EMPTY_ITEMS');
        expect(err.message).toMatch(/al menos una partida/);
    });

    it('normaliza la moneda (minúsculas y espacios) antes de compararla', () => {
        const res = calculateQuotationTotals([line({ currency: ' mxn ' }), line({ sku: 'SKU-2', currency: 'MXN' })]);
        expect(res.currency).toBe('MXN');
        expect(res.lines.map((l) => l.currency)).toEqual(['MXN', 'MXN']);
    });

    it('monedas distintas: rechazo con mensaje; misma moneda: total', () => {
        const err = captureMathError([line(), line({ sku: 'SKU-2', currency: 'USD' })]);
        expect(err.code).toBe('MIXED_CURRENCIES');
        expect(err.message).toMatch(/mezclar distintas monedas/);
        expect(calculateQuotationTotals([line(), line({ sku: 'SKU-2' })]).totalCents).toBe(23200);
    });

    it('cantidad: 0 rechazada con el SKU en el mensaje; 0.001 aceptada', () => {
        const err = captureMathError([line({ sku: 'GEL-1', quantity: 0 })]);
        expect(err.code).toBe('INVALID_QUANTITY');
        expect(err.message).toMatch(/"GEL-1".*mayor a cero/);
        expect(() => calculateQuotationTotals([line({ quantity: 0.001, unitPrice: 1000 })])).not.toThrow();
    });

    it('precio: negativo rechazado; 0 aceptado (partida sin costo)', () => {
        const err = captureMathError([line({ sku: 'NEG', unitPrice: -0.01 })]);
        expect(err.code).toBe('INVALID_UNIT_PRICE');
        expect(err.message).toMatch(/"NEG".*no puede ser negativo/);
        const res = calculateQuotationTotals([line({ unitPrice: 0 })]);
        expect(res.totalCents).toBe(0);
    });

    it('tasa: NaN, negativa y > 1 rechazadas; 0 y 1 aceptadas', () => {
        for (const taxRate of [Number.NaN, -0.01, 1.01]) {
            const err = captureMathError([line({ sku: 'TAX', taxRate })]);
            expect(err.code).toBe('INVALID_TAX_RATE');
            expect(err.message).toMatch(/"TAX".*entre 0 y 1/);
        }
        expect(calculateQuotationTotals([line({ taxRate: 0 })]).taxTotalCents).toBe(0);
        expect(calculateQuotationTotals([line({ taxRate: 1 })]).taxTotalCents).toBe(10000);
    });

    it('descuento negativo rechazado con el SKU en el mensaje', () => {
        const err = captureMathError([line({ sku: 'DESC', discountAmount: -1 })]);
        expect(err.code).toBe('INVALID_DISCOUNT');
        expect(err.message).toMatch(/"DESC".*no puede ser negativo/);
    });

    it('IVA excluido: descuento igual a la base aceptado (total 0); mayor rechazado', () => {
        const ok = calculateQuotationTotals([line({ discountAmount: 100 })]);
        expect(ok.lines[0].lineSubtotalCents).toBe(0);
        expect(ok.totalCents).toBe(0);

        const err = captureMathError([line({ sku: 'X', discountAmount: 100.01 })]);
        expect(err.code).toBe('DISCOUNT_EXCEEDS_SUBTOTAL');
        expect(err.message).toMatch(/"X".*excede el subtotal/);
    });

    it('IVA incluido: descuento igual a la base aceptado; mayor rechazado', () => {
        // 116 con IVA incluido al 16 % → base 100.00
        const ok = calculateQuotationTotals([line({ unitPrice: 116, priceIncludesTax: true, discountAmount: 100 })]);
        expect(ok.lines[0].lineSubtotalCents).toBe(0);
        expect(ok.lines[0].lineTotalCents).toBe(0);

        const err = captureMathError([
            line({ sku: 'Y', unitPrice: 116, priceIncludesTax: true, discountAmount: 100.01 }),
        ]);
        expect(err.code).toBe('DISCOUNT_EXCEEDS_SUBTOTAL');
        expect(err.message).toMatch(/"Y".*excede el subtotal/);
    });

    it('acumula descuentos por modalidad de cobro', () => {
        const res = calculateQuotationTotals([
            line({ sku: 'A', discountAmount: 10 }),
            line({ sku: 'B', discountAmount: 5 }),
            line({ sku: 'C', billingPeriod: 'mensual', discountAmount: 20 }),
        ]);
        const unico = res.totalsByBilling.find((b) => b.billingPeriod === 'unico');
        const mensual = res.totalsByBilling.find((b) => b.billingPeriod === 'mensual');
        expect(unico?.discountCents).toBe(1500);
        expect(mensual?.discountCents).toBe(2000);
        expect(res.discountTotalCents).toBe(3500);
    });
});

describe('formatFolio — bordes', () => {
    function captureFolioError(fn: () => string): FolioFormatError {
        try {
            fn();
        } catch (err) {
            if (err instanceof FolioFormatError) return err;
            throw err;
        }
        throw new Error('Se esperaba FolioFormatError');
    }

    it('prefijo inválido: error con nombre y mensaje', () => {
        const err = captureFolioError(() => formatFolio('cot', 2026, 1));
        expect(err.name).toBe('FolioFormatError');
        expect(err.message).toMatch(/prefijo/);
    });

    it('año: 2000 y 9999 aceptados; 1999 y 10000 rechazados con mensaje', () => {
        expect(formatFolio('COT', 2000, 1)).toBe('COT-2000-000001');
        expect(formatFolio('COT', 9999, 1)).toBe('COT-9999-000001');
        for (const year of [1999, 10000]) {
            expect(captureFolioError(() => formatFolio('COT', year, 1)).message).toMatch(/año/);
        }
    });

    it('consecutivo 0 rechazado con mensaje; 1 aceptado', () => {
        expect(captureFolioError(() => formatFolio('COT', 2026, 0)).message).toMatch(/consecutivo/);
        expect(formatFolio('COT', 2026, 1)).toBe('COT-2026-000001');
    });

    it('revisión: null y 0 producen el folio base; -1 rechazada con mensaje; 2 agrega sufijo', () => {
        expect(formatFolio('COT', 2026, 123, null)).toBe('COT-2026-000123');
        expect(formatFolio('COT', 2026, 123, 0)).toBe('COT-2026-000123');
        expect(captureFolioError(() => formatFolio('COT', 2026, 123, -1)).message).toMatch(/revisión/);
        expect(formatFolio('COT', 2026, 123, 2)).toBe('COT-2026-000123-R2');
    });
});

describe('validez de la cotización en la zona horaria de la organización', () => {
    it('rellena con cero mes y día de un dígito', () => {
        // 2026-01-01 12:00 UTC = 06:00 en Ciudad de México
        expect(computeValidUntilDate(new Date('2026-01-01T12:00:00Z'), 3, 'America/Mexico_City')).toBe('2026-01-04');
    });

    it('zona horaria inválida: usa la zona por defecto (Ciudad de México)', () => {
        const now = new Date('2026-03-10T03:00:00Z'); // 9 de marzo, 21:00 en CDMX
        expect(computeValidUntilDate(now, 1, 'Zona/Inexistente')).toBe(
            computeValidUntilDate(now, 1, 'America/Mexico_City')
        );
        expect(computeValidUntilDate(now, 1, 'Zona/Inexistente')).toBe('2026-03-10');
    });

    it('isValidUntilExpired: vencida solo cuando hoy (zona local) es posterior', () => {
        const now = new Date('2026-03-10T03:00:00Z'); // 9 de marzo en CDMX, 10 en UTC
        expect(isValidUntilExpired('2026-03-08', 'America/Mexico_City', now)).toBe(true);
        expect(isValidUntilExpired('2026-03-09', 'America/Mexico_City', now)).toBe(false);
        expect(isValidUntilExpired('2026-03-10', 'America/Mexico_City', now)).toBe(false);
        expect(isValidUntilExpired('2026-03-09', 'UTC', now)).toBe(true);
    });

    it('isValidUntilExpired: acepta timestamp completo y rechaza formatos inválidos', () => {
        const now = new Date('2026-03-10T18:00:00Z');
        expect(isValidUntilExpired('2026-03-09T00:00:00+00:00', 'America/Mexico_City', now)).toBe(true);
        expect(isValidUntilExpired('09/03/2026', 'America/Mexico_City', now)).toBe(false);
        expect(isValidUntilExpired('2026-3-09', 'America/Mexico_City', now)).toBe(false);
        expect(isValidUntilExpired('x2026-03-09', 'America/Mexico_City', now)).toBe(false);
        expect(isValidUntilExpired('2026-03-0a', 'America/Mexico_City', now)).toBe(false);
    });
});

describe('buildCartSpokenSummary — frases', () => {
    it('carrito vacío', () => {
        const totals = calculateQuotationTotals([line()]);
        const res = buildCartSpokenSummary({ lines: [], totals });
        expect(res.spokenItems).toBe('El carrito está vacío');
        expect(res.spokenSummary).toBe('Su cotización aún no tiene partidas.');
        expect(res.spokenTotal).toBe(amountToSpokenSpanish(0, 'MXN'));
    });

    it('sin presentación no agrega paréntesis; sin resumed no hay frase de retoma', () => {
        const totals = calculateQuotationTotals([line({ productName: 'Taladro', quantity: 2 })]);
        const res = buildCartSpokenSummary({ lines: totals.lines, totals });
        expect(res.spokenItems).toBe('2 de Taladro');
        expect(res.spokenSummary.startsWith('Lleva 2 de Taladro')).toBe(true);
    });

    it('exactamente 5 partidas: sin "más"; 6 partidas: "y 1 más", separadas por coma', () => {
        const five = calculateQuotationTotals(
            [1, 2, 3, 4, 5].map((i) => line({ sku: `S${i}`, productName: `P${i}` }))
        );
        expect(buildCartSpokenSummary({ lines: five.lines, totals: five }).spokenItems).toBe(
            '1 de P1, 1 de P2, 1 de P3, 1 de P4, 1 de P5'
        );

        const six = calculateQuotationTotals(
            [1, 2, 3, 4, 5, 6].map((i) => line({ sku: `S${i}`, productName: `P${i}` }))
        );
        expect(buildCartSpokenSummary({ lines: six.lines, totals: six }).spokenItems).toBe(
            '1 de P1, 1 de P2, 1 de P3, 1 de P4, 1 de P5 y 1 más'
        );
    });

    it('varias modalidades se unen con "más"', () => {
        const totals = calculateQuotationTotals([
            line({ sku: 'PLAN', unitPrice: 1000 }),
            line({ sku: 'MANT', unitPrice: 100, billingPeriod: 'mensual' }),
        ]);
        const res = buildCartSpokenSummary({ lines: totals.lines, totals });
        expect(res.spokenTotal).toBe(
            `${amountToSpokenSpanish(116000, 'MXN')} de pago único más ${amountToSpokenSpanish(11600, 'MXN')} mensuales, IVA incluido`
        );
    });

    it('frase de retoma en singular y en plural', () => {
        const one = calculateQuotationTotals([line()]);
        expect(buildCartSpokenSummary({ lines: one.lines, totals: one, resumed: true }).spokenSummary).toMatch(
            /^Tenía guardada una cotización con 1 partida, ¿la continuamos\? Lleva/
        );
        const two = calculateQuotationTotals([line(), line({ sku: 'S2' })]);
        expect(buildCartSpokenSummary({ lines: two.lines, totals: two, resumed: true }).spokenSummary).toMatch(
            /^Tenía guardada una cotización con 2 partidas, ¿la continuamos\? Lleva/
        );
    });
});

describe('number-to-spanish-words — bordes', () => {
    it('999 999 999 se verbaliza; desde mil millones se devuelve en cifra', () => {
        expect(numberToSpanishWords(999_999_999)).not.toBe('999999999');
        expect(numberToSpanishWords(999_999_999)).toMatch(/^novecientos noventa y nueve millones/);
        expect(numberToSpanishWords(1_000_000_000)).toBe('1000000000');
    });

    it('normaliza el código de moneda (minúsculas y espacios)', () => {
        expect(amountToSpokenSpanish(200, ' usd ')).toBe(amountToSpokenSpanish(200, 'USD'));
        expect(amountToSpokenSpanish(200, ' usd ')).toMatch(/dólares/);
    });
});
