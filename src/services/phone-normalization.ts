import parsePhoneNumberFromString, { CountryCode } from 'libphonenumber-js';

export interface PhoneNormalizationResult {
    success: boolean;
    phoneE164: string | null;
    rawInput: string;
    error?: string;
}

// Antes de la reforma de numeración de 2019, México exigía anteponer un "1"
// de trunk móvil al marcar un celular desde el extranjero (+52 1 55 1234
// 5678); la E.164 canónica actual ya no lo lleva — celulares y fijos usan el
// mismo esquema de 10 dígitos (+52 55 1234 5678). libphonenumber-js no
// despoja ese "1": lo cuenta como parte del número nacional, da 11 dígitos
// en vez de 10, y lo marca inválido — rechaza la forma histórica en vez de
// normalizarla al mismo valor que la forma moderna. Varios sistemas (más
// notablemente el wa_id de WhatsApp/Meta para números mexicanos) todavía
// entregan la forma con "1" en 2026, así que se despoja aquí, antes de
// parsear, cuando es inequívoco (código de país 52 + "1" + exactamente 10
// dígitos — ninguna otra combinación calza este patrón).
const MX_LEGACY_MOBILE_TRUNK_PREFIX = /^\+?521(\d{10})$/;

/**
 * Normaliza un número telefónico al formato E.164 (+525512345678).
 * Utiliza México (MX) como país predeterminado si no incluye código internacional.
 *
 * Si el número no puede normalizarse, devuelve `success: false` y `phoneE164: null`,
 * permitiendo al llamador continuar (ej. registrar lead sin contact_id) sin arrojar excepción.
 */
export function normalizePhoneE164(
    inputPhone: string | null | undefined,
    defaultCountry: CountryCode = 'MX'
): PhoneNormalizationResult {
    const rawInput = (inputPhone || '').trim();

    if (!rawInput) {
        return {
            success: false,
            phoneE164: null,
            rawInput,
            error: 'Número telefónico vacío o nulo',
        };
    }

    const mxLegacyMatch = defaultCountry === 'MX' ? rawInput.match(MX_LEGACY_MOBILE_TRUNK_PREFIX) : null;
    const inputToParse = mxLegacyMatch ? `+52${mxLegacyMatch[1]}` : rawInput;

    try {
        const parsed = parsePhoneNumberFromString(inputToParse, defaultCountry);

        if (parsed && parsed.isValid()) {
            return {
                success: true,
                phoneE164: parsed.format('E.164'),
                rawInput,
            };
        }

        return {
            success: false,
            phoneE164: null,
            rawInput,
            error: `No se pudo normalizar el número '${rawInput}' para el país '${defaultCountry}'`,
        };
    } catch (err: any) {
        return {
            success: false,
            phoneE164: null,
            rawInput,
            error: err.message || 'Error inesperado al parsear el número de teléfono',
        };
    }
}
