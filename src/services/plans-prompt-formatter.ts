/**
 * Servicio puro de formateo fonético y ensamble de la sección de Planes
 * para el System Prompt del Agente de Voz (ElevenLabs ConvAI).
 *
 * Convierte valores numéricos a palabras en español para garantizar
 * pronunciación perfecta en el motor TTS sin alucinaciones de cifras ni pausas.
 */

const UNITS = ['', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const TEENS = [
    'diez',
    'once',
    'doce',
    'trece',
    'catorce',
    'quince',
    'dieciséis',
    'diecisiete',
    'dieciocho',
    'diecinueve',
];
const TENS = ['', 'diez', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const HUNDREDS = [
    '',
    'ciento',
    'doscientos',
    'trescientos',
    'cuatrocientos',
    'quinientos',
    'seiscientos',
    'setecientos',
    'ochocientos',
    'novecientos',
];

function convertUnder100(n: number): string {
    if (n < 10) return UNITS[n];
    if (n >= 10 && n < 20) return TEENS[n - 10];
    if (n === 20) return 'veinte';
    if (n > 20 && n < 30) {
        const u = n % 10;
        return `veinti${UNITS[u]}`;
    }
    const ten = Math.floor(n / 10);
    const unit = n % 10;
    if (unit === 0) return TENS[ten];
    return `${TENS[ten]} y ${UNITS[unit]}`;
}

function convertUnder1000(n: number): string {
    if (n === 0) return '';
    if (n === 100) return 'cien';
    const hundred = Math.floor(n / 100);
    const remainder = n % 100;
    const hundredStr = HUNDREDS[hundred];
    const remStr = convertUnder100(remainder);
    if (!hundredStr) return remStr;
    if (!remStr) return hundredStr;
    return `${hundredStr} ${remStr}`;
}

/**
 * Convierte un número entero en su representación en palabras en español.
 * Ejemplos:
 *   7999  -> "siete mil novecientos noventa y nueve"
 *   10999 -> "diez mil novecientos noventa y nueve"
 *   28999 -> "veintiocho mil novecientos noventa y nueve"
 *   2499  -> "dos mil cuatrocientos noventa y nueve"
 *   999   -> "novecientos noventa y nueve"
 *   50000 -> "cincuenta mil"
 */
export function numberToSpanishWords(num: number): string {
    const n = Math.floor(Math.abs(num));
    if (n === 0) return 'cero';
    if (n > 999_999_999) return String(n);

    const millions = Math.floor(n / 1_000_000);
    const remainderMillions = n % 1_000_000;
    const thousands = Math.floor(remainderMillions / 1000);
    const units = remainderMillions % 1000;

    const parts: string[] = [];

    if (millions > 0) {
        if (millions === 1) {
            parts.push('un millón');
        } else {
            parts.push(`${convertUnder1000(millions)} millones`);
        }
    }

    if (thousands > 0) {
        if (thousands === 1) {
            parts.push('mil');
        } else {
            parts.push(`${convertUnder1000(thousands)} mil`);
        }
    }

    if (units > 0) {
        parts.push(convertUnder1000(units));
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export interface PlanDataForPrompt {
    key: string;
    name: string;
    setupFeeMxn: number;
    monthlyFeeMxn: number | null;
    isPopular?: boolean;
    badge?: string | null;
    setupIncludes?: string[];
    retainerIncludes?: string[];
    showRetainer?: boolean;
    targetAudience?: string | null;
}

export const DEFAULT_PLANS_SALES_DIRECTIVE =
    'Al hablar de precios, menciona un solo plan a la vez — el que mejor encaje con lo que el cliente describió. Nunca recites los cuatro planes seguidos. Si preguntan por todos, di los nombres y pregunta cuál quieren conocer a detalle.';

/**
 * Genera el bloque de texto completo "PLANES:" a partir de las filas de planes.
 */
export function generatePlansPromptBlock(
    plans: readonly PlanDataForPrompt[],
    customSalesDirective: string = DEFAULT_PLANS_SALES_DIRECTIVE
): string {
    const lines: string[] = ['PLANES:'];

    for (const plan of plans) {
        const popularTag = plan.isPopular
            ? ', el más solicitado'
            : plan.badge
              ? `, ${plan.badge.replace(/^★\s*/, '').toLowerCase()}`
              : '';

        const setupWords = numberToSpanishWords(plan.setupFeeMxn);
        const setupPrefix = plan.monthlyFeeMxn === null && plan.key === 'enterprise'
            ? `desde ${setupWords} pesos.`
            : `instalación ${setupWords} pesos.`;

        let featuresDesc = '';
        if (plan.setupIncludes && plan.setupIncludes.length > 0) {
            featuresDesc = ` ${plan.setupIncludes.join(', ')}.`;
        } else if (plan.targetAudience) {
            featuresDesc = ` ${plan.targetAudience}.`;
        }

        let retainerText = '';
        if (plan.showRetainer !== false && plan.monthlyFeeMxn !== null && plan.monthlyFeeMxn !== undefined) {
            const monthlyWords = numberToSpanishWords(plan.monthlyFeeMxn);
            retainerText = ` Iguala opcional ${monthlyWords} pesos al mes.`;
        }

        lines.push(`${plan.name}${popularTag} — ${setupPrefix}${featuresDesc}${retainerText}`.trim());
    }

    if (customSalesDirective) {
        lines.push(customSalesDirective);
    }

    return lines.join('\n');
}

/**
 * Inyecta o reemplaza la sección PLANES:... dentro de un System Prompt existente.
 * Si ya existe una sección PLANES:, la reemplaza completamente preservando el resto del prompt.
 * Si no existe, la añade antes de cualquier sección final o al final del prompt.
 */
export function injectPlansSectionIntoPrompt(currentPrompt: string, newPlansBlock: string): string {
    const plansSectionRegex = /(?:^|\n\s*)(?:#{1,3}\s*)?PLANES:\s*\n[\s\S]*?(?=(\n\s*(?:[A-ZÁÉÍÓÚÑ\s_]{3,}:|#{1,3}\s+[A-ZÁÉÍÓÚÑ]|$)))/i;

    const trimmedBlock = newPlansBlock.trim();

    if (plansSectionRegex.test(currentPrompt)) {
        return currentPrompt
            .replace(plansSectionRegex, (match) => {
                const hasLeadingNewline = match.startsWith('\n');
                return `${hasLeadingNewline ? '\n\n' : ''}${trimmedBlock}`;
            })
            .trim();
    }

    // Si no existía, concatenar con doble salto de línea
    return `${currentPrompt.trim()}\n\n${trimmedBlock}`.trim();
}
