/**
 * Conversión de números e importes monetarios (en centavos enteros) a palabras
 * en español hablado (para pronunciación TTS en ElevenLabs ConvAI) y a formato
 * legal en mayúsculas para cotizaciones/remisiones PDF.
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
    if (n < 20) return TEENS[n - 10];
    if (n === 20) return 'veinte';
    if (n < 30) {
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

interface CurrencyLabels {
    singular: string;
    plural: string;
    legalSuffix: string;
}

const CURRENCY_MAP: Record<string, CurrencyLabels> = {
    MXN: { singular: 'peso', plural: 'pesos', legalSuffix: 'M.N.' },
    USD: { singular: 'dólar', plural: 'dólares', legalSuffix: 'USD' },
    EUR: { singular: 'euro', plural: 'euros', legalSuffix: 'EUR' },
};

function resolveCurrencyLabels(currency: string): CurrencyLabels {
    const code = currency.trim().toUpperCase();
    return CURRENCY_MAP[code] ?? { singular: code, plural: code, legalSuffix: code };
}

function isExactMillions(wholeUnits: number): boolean {
    return wholeUnits >= 1_000_000 && wholeUnits % 1_000_000 === 0;
}

/**
 * Convierte un importe en centavos enteros a texto hablado para el agente
 * conversacional (ej. `185050, 'MXN'` → `"mil ochocientos cincuenta pesos con cincuenta centavos"`).
 */
export function amountToSpokenSpanish(cents: number, currency: string = 'MXN'): string {
    const safeCents = Math.round(Math.abs(cents));
    const whole = Math.floor(safeCents / 100);
    const centavos = safeCents % 100;
    const labels = resolveCurrencyLabels(currency);

    const wholeWords = numberToSpanishWords(whole);
    const currencyWord = whole === 1 ? labels.singular : isExactMillions(whole) ? `de ${labels.plural}` : labels.plural;

    if (centavos === 0) {
        return `${wholeWords} ${currencyWord}`;
    }

    const centavosWords = numberToSpanishWords(centavos);
    const centavoNoun = centavos === 1 ? 'centavo' : 'centavos';
    return `${wholeWords} ${currencyWord} con ${centavosWords} ${centavoNoun}`;
}

/**
 * Convierte un importe en centavos enteros al formato legal en mayúsculas para
 * documentos PDF (ej. `185050, 'MXN'` → `"(MIL OCHOCIENTOS CINCUENTA PESOS 50/100 M.N.)"`).
 */
export function amountToLegalSpanish(cents: number, currency: string = 'MXN'): string {
    const safeCents = Math.round(Math.abs(cents));
    const whole = Math.floor(safeCents / 100);
    const centavos = safeCents % 100;
    const labels = resolveCurrencyLabels(currency);

    const wholeWords = numberToSpanishWords(whole).toUpperCase();
    const currencyWord = (
        whole === 1 ? labels.singular : isExactMillions(whole) ? `DE ${labels.plural}` : labels.plural
    ).toUpperCase();
    const paddedCents = String(centavos).padStart(2, '0');

    return `(${wholeWords} ${currencyWord} ${paddedCents}/100 ${labels.legalSuffix})`;
}
