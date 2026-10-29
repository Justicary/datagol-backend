import type { CatalogItemType } from '../../types/catalog-item-type.js';
import { ALL_BILLING_PERIODS, type BillingPeriod } from '../../types/billing-period.js';

export type QuotationMathErrorCode =
    | 'EMPTY_ITEMS'
    | 'MIXED_CURRENCIES'
    | 'INVALID_QUANTITY'
    | 'INVALID_UNIT_PRICE'
    | 'INVALID_TAX_RATE'
    | 'INVALID_DISCOUNT'
    | 'DISCOUNT_EXCEEDS_SUBTOTAL';

export class QuotationMathError extends Error {
    public readonly code: QuotationMathErrorCode;

    constructor(code: QuotationMathErrorCode, message: string) {
        super(message);
        this.name = 'QuotationMathError';
        this.code = code;
    }
}

export interface QuotationLineInput {
    sku: string;
    productName: string;
    presentation?: string | null;
    itemType: CatalogItemType;
    billingPeriod: BillingPeriod;
    quantity: number;
    unitPrice: number;
    currency: string;
    priceIncludesTax: boolean;
    taxRate: number;
    discountAmount?: number;
}

export interface QuotationLineCalculated extends QuotationLineInput {
    discountAmount: number;
    discountCents: number;
    lineSubtotalCents: number;
    lineTaxCents: number;
    lineTotalCents: number;
    lineSubtotal: number;
    lineTax: number;
    lineTotal: number;
}

export interface BillingPeriodTotalBlock {
    billingPeriod: BillingPeriod;
    subtotalCents: number;
    taxCents: number;
    discountCents: number;
    totalCents: number;
    subtotal: number;
    tax: number;
    discount: number;
    total: number;
}

export interface TaxBreakdownEntry {
    taxRate: number;
    baseCents: number;
    taxCents: number;
    base: number;
    tax: number;
}

export interface QuotationTotalsResult {
    currency: string;
    lines: QuotationLineCalculated[];
    subtotalCents: number;
    taxTotalCents: number;
    discountTotalCents: number;
    totalCents: number;
    subtotal: number;
    taxTotal: number;
    discountTotal: number;
    total: number;
    totalsByBilling: BillingPeriodTotalBlock[];
    taxBreakdown: TaxBreakdownEntry[];
}

/**
 * Redondeo half-up al entero más cercano (en centavos): `.5` redondea siempre
 * alejándose de cero, compatible con CFDI 4.0.
 */
export function halfUpRoundCents(value: number): number {
    if (value === 0) return 0;
    const sign = value < 0 ? -1 : 1;
    return sign * Math.floor(Math.abs(value) + 0.5 + 1e-12);
}

function centsToUnits(cents: number): number {
    return cents / 100;
}

/**
 * Calcula los importes por partida, el desglose por modalidad de cobro
 * (`totalsByBilling`), el desglose de impuestos por tasa (`taxBreakdown`) y el
 * total inicial (`total = únicos + primer periodo de recurrentes`) operando
 * exclusivamente sobre centavos enteros.
 */
export function calculateQuotationTotals(items: readonly QuotationLineInput[]): QuotationTotalsResult {
    if (items.length === 0) {
        throw new QuotationMathError('EMPTY_ITEMS', 'La cotización debe contener al menos una partida.');
    }

    const firstCurrency = items[0].currency.trim().toUpperCase();
    const calculatedLines: QuotationLineCalculated[] = [];

    for (const item of items) {
        const normalizedCurrency = item.currency.trim().toUpperCase();
        if (normalizedCurrency !== firstCurrency) {
            throw new QuotationMathError(
                'MIXED_CURRENCIES',
                'No se pueden mezclar distintas monedas en una misma cotización.'
            );
        }

        if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
            throw new QuotationMathError(
                'INVALID_QUANTITY',
                `La cantidad para el SKU "${item.sku}" debe ser mayor a cero.`
            );
        }

        if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
            throw new QuotationMathError(
                'INVALID_UNIT_PRICE',
                `El precio unitario para el SKU "${item.sku}" no puede ser negativo.`
            );
        }

        if (!Number.isFinite(item.taxRate) || item.taxRate < 0 || item.taxRate > 1) {
            throw new QuotationMathError(
                'INVALID_TAX_RATE',
                `La tasa de impuesto para el SKU "${item.sku}" debe estar entre 0 y 1.`
            );
        }

        const rawDiscount = item.discountAmount ?? 0;
        if (!Number.isFinite(rawDiscount) || rawDiscount < 0) {
            throw new QuotationMathError(
                'INVALID_DISCOUNT',
                `El descuento para el SKU "${item.sku}" no puede ser negativo.`
            );
        }

        const discountCents = halfUpRoundCents(rawDiscount * 100);
        const grossAmountCents = halfUpRoundCents(item.unitPrice * 100 * item.quantity);

        let lineSubtotalCents: number;
        let lineTaxCents: number;
        let lineTotalCents: number;

        if (item.priceIncludesTax) {
            const baseBeforeDiscountCents = halfUpRoundCents(grossAmountCents / (1 + item.taxRate));
            if (discountCents > baseBeforeDiscountCents) {
                throw new QuotationMathError(
                    'DISCOUNT_EXCEEDS_SUBTOTAL',
                    `El descuento para el SKU "${item.sku}" excede el subtotal antes de impuestos.`
                );
            }
            lineSubtotalCents = baseBeforeDiscountCents - discountCents;
            if (discountCents === 0) {
                lineTaxCents = grossAmountCents - lineSubtotalCents;
                lineTotalCents = grossAmountCents;
            } else {
                lineTaxCents = halfUpRoundCents(lineSubtotalCents * item.taxRate);
                lineTotalCents = lineSubtotalCents + lineTaxCents;
            }
        } else {
            const baseBeforeDiscountCents = grossAmountCents;
            if (discountCents > baseBeforeDiscountCents) {
                throw new QuotationMathError(
                    'DISCOUNT_EXCEEDS_SUBTOTAL',
                    `El descuento para el SKU "${item.sku}" excede el subtotal antes de impuestos.`
                );
            }
            lineSubtotalCents = baseBeforeDiscountCents - discountCents;
            lineTaxCents = halfUpRoundCents(lineSubtotalCents * item.taxRate);
            lineTotalCents = lineSubtotalCents + lineTaxCents;
        }

        calculatedLines.push({
            ...item,
            currency: normalizedCurrency,
            discountAmount: centsToUnits(discountCents),
            discountCents,
            lineSubtotalCents,
            lineTaxCents,
            lineTotalCents,
            lineSubtotal: centsToUnits(lineSubtotalCents),
            lineTax: centsToUnits(lineTaxCents),
            lineTotal: centsToUnits(lineTotalCents),
        });
    }

    let subtotalCents = 0;
    let taxTotalCents = 0;
    let discountTotalCents = 0;
    let totalCents = 0;

    const billingAccum = new Map<
        BillingPeriod,
        { subtotalCents: number; taxCents: number; discountCents: number; totalCents: number }
    >();
    const taxAccum = new Map<number, { baseCents: number; taxCents: number }>();

    for (const line of calculatedLines) {
        subtotalCents += line.lineSubtotalCents;
        taxTotalCents += line.lineTaxCents;
        discountTotalCents += line.discountCents;
        totalCents += line.lineTotalCents;

        const prevBilling = billingAccum.get(line.billingPeriod) ?? {
            subtotalCents: 0,
            taxCents: 0,
            discountCents: 0,
            totalCents: 0,
        };
        prevBilling.subtotalCents += line.lineSubtotalCents;
        prevBilling.taxCents += line.lineTaxCents;
        prevBilling.discountCents += line.discountCents;
        prevBilling.totalCents += line.lineTotalCents;
        billingAccum.set(line.billingPeriod, prevBilling);

        const prevTax = taxAccum.get(line.taxRate) ?? { baseCents: 0, taxCents: 0 };
        prevTax.baseCents += line.lineSubtotalCents;
        prevTax.taxCents += line.lineTaxCents;
        taxAccum.set(line.taxRate, prevTax);
    }

    const totalsByBilling: BillingPeriodTotalBlock[] = [];
    for (const period of ALL_BILLING_PERIODS) {
        const entry = billingAccum.get(period);
        if (!entry) continue;
        totalsByBilling.push({
            billingPeriod: period,
            subtotalCents: entry.subtotalCents,
            taxCents: entry.taxCents,
            discountCents: entry.discountCents,
            totalCents: entry.totalCents,
            subtotal: centsToUnits(entry.subtotalCents),
            tax: centsToUnits(entry.taxCents),
            discount: centsToUnits(entry.discountCents),
            total: centsToUnits(entry.totalCents),
        });
    }

    const sortedTaxRates = Array.from(taxAccum.keys()).sort((a, b) => a - b);
    const taxBreakdown: TaxBreakdownEntry[] = sortedTaxRates.map((rate) => {
        const entry = taxAccum.get(rate)!;
        return {
            taxRate: rate,
            baseCents: entry.baseCents,
            taxCents: entry.taxCents,
            base: centsToUnits(entry.baseCents),
            tax: centsToUnits(entry.taxCents),
        };
    });

    return {
        currency: firstCurrency,
        lines: calculatedLines,
        subtotalCents,
        taxTotalCents,
        discountTotalCents,
        totalCents,
        subtotal: centsToUnits(subtotalCents),
        taxTotal: centsToUnits(taxTotalCents),
        discountTotal: centsToUnits(discountTotalCents),
        total: centsToUnits(totalCents),
        totalsByBilling,
        taxBreakdown,
    };
}
