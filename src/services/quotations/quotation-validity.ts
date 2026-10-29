const DEFAULT_TIMEZONE = 'America/Mexico_City';

function formatDateInTimezone(date: Date, timezone: string): string {
    try {
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        return formatter.format(date);
    } catch {
        const fallback = new Intl.DateTimeFormat('en-CA', {
            timeZone: DEFAULT_TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        return fallback.format(date);
    }
}

/**
 * Calcula la fecha `valid_until` (`YYYY-MM-DD`) sumando `validityDays` a la
 * fecha calendario actual en la zona horaria de la organización (`organizations.timezone`).
 */
export function computeValidUntilDate(now: Date, validityDays: number, timezone: string = DEFAULT_TIMEZONE): string {
    const todayStr = formatDateInTimezone(now, timezone);
    const [year, month, day] = todayStr.split('-').map(Number);
    const safeDays = Math.max(1, Math.floor(validityDays));
    const utcDate = new Date(Date.UTC(year, month - 1, day + safeDays));
    const y = utcDate.getUTCFullYear();
    const m = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(utcDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Determina si una fecha `valid_until` (`YYYY-MM-DD`) ya venció con respecto
 * al día calendario actual en la zona horaria de la organización (`today > validUntil`).
 */
export function isValidUntilExpired(
    validUntil: string,
    timezone: string = DEFAULT_TIMEZONE,
    now: Date = new Date()
): boolean {
    const cleanValidUntil = validUntil.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanValidUntil)) {
        return false;
    }
    const todayStr = formatDateInTimezone(now, timezone);
    return todayStr > cleanValidUntil;
}

