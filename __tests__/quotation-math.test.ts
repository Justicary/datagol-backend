import { describe, it, expect } from 'vitest';
import {
    calculateQuotationTotals,
    halfUpRoundCents,
    QuotationMathError,
    type QuotationLineInput,
} from '../src/services/quotations/quotation-math.js';
import { formatFolio, FolioFormatError } from '../src/services/quotations/quotation-folio.js';
import { buildCartSpokenSummary } from '../src/services/quotations/quotation-cart-summary.js';
import { computeValidUntilDate } from '../src/services/quotations/quotation-validity.js';

describe('Fase C — Servicios Puros de Cotizaciones', () => {
    describe('halfUpRoundCents', () => {
        it('redondea half-up en el límite exacto .5 y hacia abajo en < .5', () => {
            expect(halfUpRoundCents(10.5)).toBe(11);
            expect(halfUpRoundCents(10.499)).toBe(10);
            expect(halfUpRoundCents(0)).toBe(0);
            expect(halfUpRoundCents(100.5)).toBe(101);
            expect(halfUpRoundCents(-10.5)).toBe(-11);
        });
    });

    describe('calculateQuotationTotals — aritmética en centavos enteros', () => {
        it('calcula correctamente partidas sin IVA incluido (priceIncludesTax = false)', () => {
            const lines: QuotationLineInput[] = [
                {
                    sku: 'PROD-1',
                    productName: 'Producto 1',
                    itemType: 'producto',
                    billingPeriod: 'unico',
                    quantity: 2,
                    unitPrice: 100,
                    currency: 'MXN',
                    priceIncludesTax: false,
                    taxRate: 0.16,
                },
            ];

            const res = calculateQuotationTotals(lines);
            expect(res.currency).toBe('MXN');
            expect(res.subtotalCents).toBe(20000);
            expect(res.taxTotalCents).toBe(3200);
            expect(res.discountTotalCents).toBe(0);
            expect(res.totalCents).toBe(23200);
            expect(res.subtotal).toBe(200);
            expect(res.taxTotal).toBe(32);
            expect(res.discountTotal).toBe(0);
            expect(res.total).toBe(232);
            expect(res.lines[0].lineSubtotal).toBe(200);
            expect(res.lines[0].lineTax).toBe(32);
            expect(res.lines[0].lineTotal).toBe(232);
        });

        it('calcula correctamente partidas con IVA incluido (priceIncludesTax = true) garantizando base + iva = total', () => {
            const lines: QuotationLineInput[] = [
                {
                    sku: 'PROD-IVA',
                    productName: 'Producto con IVA',
                    itemType: 'producto',
                    billingPeriod: 'unico',
                    quantity: 1,
                    unitPrice: 116,
                    currency: 'MXN',
                    priceIncludesTax: true,
                    taxRate: 0.16,
                },
                {
                    sku: 'PROD-IVA-ODD',
                    productName: 'Producto con IVA centavo impar',
                    itemType: 'producto',
                    billingPeriod: 'unico',
                    quantity: 3,
                    unitPrice: 99.99,
                    currency: 'MXN',
                    priceIncludesTax: true,
                    taxRate: 0.16,
                },
            ];

            const res = calculateQuotationTotals(lines);
            expect(res.lines[0].lineSubtotalCents).toBe(10000);
            expect(res.lines[0].lineTaxCents).toBe(1600);
            expect(res.lines[0].lineTotalCents).toBe(11600);

            // 3 * 9999 = 29997 centavos brutos. base = round(29997 / 1.16) = round(25859.4827...) = 25859. iva = 29997 - 25859 = 4138.
            expect(res.lines[1].lineSubtotalCents).toBe(25859);
            expect(res.lines[1].lineTaxCents).toBe(4138);
            expect(res.lines[1].lineTotalCents).toBe(29997);
            expect(res.lines[1].lineSubtotalCents + res.lines[1].lineTaxCents).toBe(res.lines[1].lineTotalCents);
        });

        it('aplica descuento sobre la base antes de impuestos tanto con IVA excluido como incluido', () => {
            const resExcluded = calculateQuotationTotals([
                {
                    sku: 'DESC-1',
                    productName: 'Con descuento sin IVA',
                    itemType: 'servicio',
                    billingPeriod: 'unico',
                    quantity: 2,
                    unitPrice: 500,
                    currency: 'MXN',
                    priceIncludesTax: false,
                    taxRate: 0.16,
                    discountAmount: 100,
                },
            ]);
            // Base bruta = 1000, descuento = 100 -> subtotal = 900, IVA = 144, total = 1044
            expect(resExcluded.subtotal).toBe(900);
            expect(resExcluded.discountTotal).toBe(100);
            expect(resExcluded.taxTotal).toBe(144);
            expect(resExcluded.total).toBe(1044);

            const resIncluded = calculateQuotationTotals([
                {
                    sku: 'DESC-2',
                    productName: 'Con descuento con IVA',
                    itemType: 'servicio',
                    billingPeriod: 'unico',
                    quantity: 1,
                    unitPrice: 1160,
                    currency: 'MXN',
                    priceIncludesTax: true,
                    taxRate: 0.16,
                    discountAmount: 100,
                },
            ]);
            // Base bruta = 1000, descuento = 100 -> subtotal = 900, IVA = 144, total = 1044
            expect(resIncluded.subtotal).toBe(900);
            expect(resIncluded.discountTotal).toBe(100);
            expect(resIncluded.taxTotal).toBe(144);
            expect(resIncluded.total).toBe(1044);
        });

        it('agrupa totalsByBilling (unico, mensual, anual) y taxBreakdown por tasa correctamente', () => {
            const res = calculateQuotationTotals([
                {
                    sku: 'PLAN-PRO',
                    productName: 'Plan Pro',
                    itemType: 'plan',
                    billingPeriod: 'unico',
                    quantity: 1,
                    unitPrice: 20000,
                    currency: 'MXN',
                    priceIncludesTax: false,
                    taxRate: 0.16,
                },
                {
                    sku: 'MANT-PRO-MENSUAL',
                    productName: 'Mantenimiento Plan Pro',
                    itemType: 'servicio',
                    billingPeriod: 'mensual',
                    quantity: 1,
                    unitPrice: 3000,
                    currency: 'MXN',
                    priceIncludesTax: false,
                    taxRate: 0.16,
                },
                {
                    sku: 'MED-EXENTO',
                    productName: 'Insumo Tasa 0',
                    itemType: 'producto',
                    billingPeriod: 'unico',
                    quantity: 2.5,
                    unitPrice: 100,
                    currency: 'MXN',
                    priceIncludesTax: false,
                    taxRate: 0,
                },
            ]);

            expect(res.totalsByBilling).toHaveLength(2);
            expect(res.totalsByBilling[0]).toEqual({
                billingPeriod: 'unico',
                subtotalCents: 2025000,
                taxCents: 320000,
                discountCents: 0,
                totalCents: 2345000,
                subtotal: 20250,
                tax: 3200,
                discount: 0,
                total: 23450,
            });
            expect(res.totalsByBilling[1]).toEqual({
                billingPeriod: 'mensual',
                subtotalCents: 300000,
                taxCents: 48000,
                discountCents: 0,
                totalCents: 348000,
                subtotal: 3000,
                tax: 480,
                discount: 0,
                total: 3480,
            });

            // Total inicial = único + primer periodo mensual
            expect(res.total).toBe(26930);

            expect(res.taxBreakdown).toEqual([
                { taxRate: 0, baseCents: 25000, taxCents: 0, base: 250, tax: 0 },
                { taxRate: 0.16, baseCents: 2300000, taxCents: 368000, base: 23000, tax: 3680 },
            ]);
        });

        it('rechaza monedas mezcladas, lista vacía, cantidades <= 0, precios negativos, tasas inválidas y descuentos mayores a la base', () => {
            expect(() => calculateQuotationTotals([])).toThrowError(QuotationMathError);

            expect(() =>
                calculateQuotationTotals([
                    {
                        sku: 'A',
                        productName: 'A',
                        itemType: 'producto',
                        billingPeriod: 'unico',
                        quantity: 1,
                        unitPrice: 100,
                        currency: 'MXN',
                        priceIncludesTax: false,
                        taxRate: 0.16,
                    },
                    {
                        sku: 'B',
                        productName: 'B',
                        itemType: 'producto',
                        billingPeriod: 'unico',
                        quantity: 1,
                        unitPrice: 10,
                        currency: 'USD',
                        priceIncludesTax: false,
                        taxRate: 0.16,
                    },
                ])
            ).toThrow(/monedas/i);

            expect(() =>
                calculateQuotationTotals([
                    {
                        sku: 'A',
                        productName: 'A',
                        itemType: 'producto',
                        billingPeriod: 'unico',
                        quantity: 0,
                        unitPrice: 100,
                        currency: 'MXN',
                        priceIncludesTax: false,
                        taxRate: 0.16,
                    },
                ])
            ).toThrow(/cantidad/i);

            expect(() =>
                calculateQuotationTotals([
                    {
                        sku: 'A',
                        productName: 'A',
                        itemType: 'producto',
                        billingPeriod: 'unico',
                        quantity: 1,
                        unitPrice: -5,
                        currency: 'MXN',
                        priceIncludesTax: false,
                        taxRate: 0.16,
                    },
                ])
            ).toThrow(/precio/i);

            expect(() =>
                calculateQuotationTotals([
                    {
                        sku: 'A',
                        productName: 'A',
                        itemType: 'producto',
                        billingPeriod: 'unico',
                        quantity: 1,
                        unitPrice: 100,
                        currency: 'MXN',
                        priceIncludesTax: false,
                        taxRate: 1.5,
                    },
                ])
            ).toThrow(/tasa/i);

            expect(() =>
                calculateQuotationTotals([
                    {
                        sku: 'A',
                        productName: 'A',
                        itemType: 'producto',
                        billingPeriod: 'unico',
                        quantity: 1,
                        unitPrice: 100,
                        currency: 'MXN',
                        priceIncludesTax: false,
                        taxRate: 0.16,
                        discountAmount: -1,
                    },
                ])
            ).toThrow(/descuento/i);

            expect(() =>
                calculateQuotationTotals([
                    {
                        sku: 'A',
                        productName: 'A',
                        itemType: 'producto',
                        billingPeriod: 'unico',
                        quantity: 1,
                        unitPrice: 100,
                        currency: 'MXN',
                        priceIncludesTax: false,
                        taxRate: 0.16,
                        discountAmount: 150,
                    },
                ])
            ).toThrow(/descuento/i);
        });
    });

    describe('quotation-folio.ts — formatFolio', () => {
        it('formatea folios base y revisiones, y rechaza entradas inválidas', () => {
            expect(formatFolio('COT', 2026, 1)).toBe('COT-2026-000001');
            expect(formatFolio('DATAGOL1', 2026, 42, 0)).toBe('DATAGOL1-2026-000042');
            expect(formatFolio('COT', 2026, 42, 2)).toBe('COT-2026-000042-R2');

            expect(() => formatFolio('cot', 2026, 1)).toThrowError(FolioFormatError);
            expect(() => formatFolio('PREFIJOMUYLARGO', 2026, 1)).toThrowError(FolioFormatError);
            expect(() => formatFolio('COT', 1999, 1)).toThrowError(FolioFormatError);
            expect(() => formatFolio('COT', 2026, 0)).toThrowError(FolioFormatError);
            expect(() => formatFolio('COT', 2026, 1, -1)).toThrowError(FolioFormatError);
        });
    });

    describe('quotation-cart-summary.ts — buildCartSpokenSummary', () => {
        it('enumera máximo 5 partidas, agrega "y N más", desglosa por modalidad e incluye frase de retoma cuando resumed=true', () => {
            const totals = calculateQuotationTotals(
                Array.from({ length: 7 }, (_, i) => ({
                    sku: `SKU-${i + 1}`,
                    productName: `Producto ${i + 1}`,
                    itemType: i === 0 ? ('plan' as const) : ('servicio' as const),
                    billingPeriod: i === 0 ? ('unico' as const) : ('mensual' as const),
                    quantity: 1,
                    unitPrice: 100,
                    currency: 'MXN',
                    priceIncludesTax: true,
                    taxRate: 0.16,
                }))
            );

            const summary = buildCartSpokenSummary({
                lines: totals.lines,
                totals,
                resumed: true,
            });

            expect(summary.spokenItems).toContain('Producto 1');
            expect(summary.spokenItems).toContain('Producto 5');
            expect(summary.spokenItems).not.toContain('Producto 6');
            expect(summary.spokenItems).toContain('y 2 más');
            expect(summary.spokenTotal).toContain('pago único');
            expect(summary.spokenTotal).toContain('mensuales');
            expect(summary.spokenSummary).toContain('Tenía guardada una cotización');
        });
    });

    describe('quotation-validity.ts — computeValidUntilDate', () => {
        it('calcula la fecha YYYY-MM-DD en la zona horaria de la organización', () => {
            // 2026-10-26T23:30:00Z son las 17:30 del 2026-10-26 en America/Mexico_City
            const now = new Date('2026-10-26T23:30:00.000Z');
            expect(computeValidUntilDate(now, 15, 'America/Mexico_City')).toBe('2026-11-10');
            // En UTC+2 (Europe/Madrid) ya es 2026-10-27 00:30, + 15 días = 2026-11-11
            expect(computeValidUntilDate(now, 15, 'Europe/Madrid')).toBe('2026-11-11');
            // Zona inválida cae en America/Mexico_City sin lanzar excepción
            expect(computeValidUntilDate(now, 15, 'Zona/Inexistente')).toBe('2026-11-10');
        });
    });
});
