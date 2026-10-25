import crypto from 'crypto';

/**
 * Comparación en tiempo constante de dos cadenas UTF-8 para verificar
 * secretos de webhook o headers de autenticación (`x-tool-secret`,
 * `X-Telegram-Bot-Api-Secret-Token`).
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
    if (!a || !b) {
        return false;
    }
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');
    if (bufferA.length !== bufferB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufferA, bufferB);
}
