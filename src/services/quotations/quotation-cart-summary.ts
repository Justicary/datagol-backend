import { amountToSpokenSpanish } from '../../lib/number-to-spanish-words.js';
import type { QuotationLineCalculated, QuotationTotalsResult } from './quotation-math.js';

export const MAX_ENUMERATED_CART_ITEMS = 5;

export interface CartSpokenSummaryResult {
    spokenItems: string;
    spokenTotal: string;
    spokenSummary: string;
}

const BILLING_SPOKEN_SUFFIX: Record<string, string> = {
    unico: 'de pago único',
    mensual: 'mensuales',
    anual: 'anuales',
};

/**
 * Construye el resumen verbalizable de un carrito de cotización (Fase C.4):
 * - Enumera hasta 5 partidas y resume el resto como `"y N más"`.
 * - Desglosa los importes por modalidad de cobro (`unico`, `mensual`, `anual`)
 *   con `amountToSpokenSpanish` (con IVA incluido sobre el total de cada bloque).
 * - Si `resumed` es verdadero, antepone la frase de retoma de carrito previo.
 */
export function buildCartSpokenSummary(params: {
    lines: readonly QuotationLineCalculated[];
    totals: QuotationTotalsResult;
    resumed?: boolean;
}): CartSpokenSummaryResult {
    const { lines, totals, resumed = false } = params;

    if (lines.length === 0) {
        return {
            spokenItems: 'El carrito está vacío',
            spokenTotal: amountToSpokenSpanish(0, totals.currency),
            spokenSummary: 'Su cotización aún no tiene partidas.',
        };
    }

    const visibleLines = lines.slice(0, MAX_ENUMERATED_CART_ITEMS);
    const remainingCount = Math.max(0, lines.length - visibleLines.length);

    const itemPhrases = visibleLines.map((line) => {
        const qtyStr = Number.isInteger(line.quantity) ? String(line.quantity) : String(line.quantity);
        const presStr = line.presentation ? ` (${line.presentation})` : '';
        return `${qtyStr} de ${line.productName}${presStr}`;
    });

    const spokenItems =
        remainingCount > 0 ? `${itemPhrases.join(', ')} y ${remainingCount} más` : itemPhrases.join(', ');

    const billingPhrases = totals.totalsByBilling.map((block) => {
        const amountWords = amountToSpokenSpanish(block.totalCents, totals.currency);
        const suffix = BILLING_SPOKEN_SUFFIX[block.billingPeriod] ?? block.billingPeriod;
        return `${amountWords} ${suffix}`;
    });

    const spokenTotal = `${billingPhrases.join(' más ')}, IVA incluido`;

    const resumedPrefix = resumed
        ? `Tenía guardada una cotización con ${lines.length} ${lines.length === 1 ? 'partida' : 'partidas'}, ¿la continuamos? `
        : '';

    const spokenSummary = `${resumedPrefix}Lleva ${spokenItems}, con un total de ${spokenTotal}.`;

    return {
        spokenItems,
        spokenTotal,
        spokenSummary,
    };
}
