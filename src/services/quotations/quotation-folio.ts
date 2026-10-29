export class FolioFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FolioFormatError';
    }
}

const FOLIO_PREFIX_REGEX = /^[A-Z0-9]{1,8}$/;

/**
 * Formatea un folio consecutivo anual (`{PREFIJO}-{AAAA}-{000000}`) y su
 * sufijo opcional de revisión (`-R{n}`).
 */
export function formatFolio(prefix: string, year: number, number: number, revision?: number | null): string {
    if (!FOLIO_PREFIX_REGEX.test(prefix)) {
        throw new FolioFormatError('El prefijo del folio debe tener entre 1 y 8 caracteres alfanuméricos en mayúsculas.');
    }
    if (!Number.isInteger(year) || year < 2000 || year > 9999) {
        throw new FolioFormatError('El año del folio debe ser un entero de 4 dígitos entre 2000 y 9999.');
    }
    if (!Number.isInteger(number) || number < 1) {
        throw new FolioFormatError('El consecutivo del folio debe ser un entero mayor o igual a 1.');
    }
    if (revision !== undefined && revision !== null) {
        if (!Number.isInteger(revision) || revision < 0) {
            throw new FolioFormatError('El número de revisión debe ser un entero mayor o igual a 0.');
        }
    }

    const base = `${prefix}-${year}-${String(number).padStart(6, '0')}`;
    // Ya validado como entero >= 0: la revisión 0 es el folio base, sin sufijo.
    if (revision) {
        return `${base}-R${revision}`;
    }
    return base;
}
