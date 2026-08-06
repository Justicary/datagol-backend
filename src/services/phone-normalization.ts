import parsePhoneNumberFromString, { CountryCode } from 'libphonenumber-js';

export interface PhoneNormalizationResult {
    success: boolean;
    phoneE164: string | null;
    rawInput: string;
    error?: string;
}

/**
 * Normaliza un número telefónico al formato E.164 (+521234567890).
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

    try {
        const parsed = parsePhoneNumberFromString(rawInput, defaultCountry);

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
