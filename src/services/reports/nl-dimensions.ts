import {
    NL_PERIOD_TYPES,
    NL_COMPARE_TO_DIMENSIONS,
    type NlPeriodType,
    type NlCompareToDimension,
    type ResolvedPeriod,
} from '../../types/natural-reports.js';
import type { NlPeriodParam } from '../../schemas/natural-reports.js';

export const DEFAULT_TIMEZONE = 'America/Mexico_City';

interface ZonedParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

const MONTH_NAMES_ES = [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
];

export function getZonedDateParts(date: Date, timeZone: string): ZonedParts {
    const tz = isValidTimezone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const map = new Map(parts.map((p) => [p.type, p.value]));
    return {
        year: Number(map.get('year')),
        month: Number(map.get('month')),
        day: Number(map.get('day')),
        hour: Number(map.get('hour')),
        minute: Number(map.get('minute')),
        second: Number(map.get('second')),
    };
}

export function isValidTimezone(tz: string): boolean {
    if (!tz || typeof tz !== 'string') return false;
    try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * Convierte una fecha y hora local expresada en una zona horaria a su Date UTC correspondiente.
 */
export function zonedDateTimeToUtc(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    millisecond: number,
    timeZone: string
): Date {
    const tz = isValidTimezone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
    const approx = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
    const parts = getZonedDateParts(approx, tz);
    const approxLocal = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, millisecond));
    const offsetMs = approxLocal.getTime() - approx.getTime();
    return new Date(approx.getTime() - offsetMs);
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : `${n}`;
}

function formatLocalDate(year: number, month: number, day: number): string {
    return `${year}-${pad2(month)}-${pad2(day)}`;
}

function getDaysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Obtiene el día de la semana en formato ISO (1 = Lunes, 7 = Domingo) para una fecha local.
 */
function getIsoWeekday(year: number, month: number, day: number): number {
    const d = new Date(Date.UTC(year, month - 1, day));
    const dayOfWeek = d.getUTCDay(); // 0 = Domingo, 1 = Lunes...
    return dayOfWeek === 0 ? 7 : dayOfWeek;
}

export interface ResolvePeriodOptions {
    now?: Date;
    compareTo?: NlCompareToDimension;
}

/**
 * Resuelve un periodo temporal expresado en lenguaje natural o parámetros
 * a marcas de tiempo UTC exactas usando la zona horaria de la organización.
 */
export function resolvePeriod(
    param?: NlPeriodParam,
    timezone: string = DEFAULT_TIMEZONE,
    options?: ResolvePeriodOptions
): ResolvedPeriod {
    const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
    const now = options?.now ?? new Date();
    const currentZoned = getZonedDateParts(now, tz);
    const type = (param?.type ?? NL_PERIOD_TYPES.ESTE_MES) as NlPeriodType;

    let startUtcDate: Date;
    let endUtcDate: Date;
    let startLocalStr: string;
    let endLocalStr: string;
    let label: string;

    switch (type) {
        case NL_PERIOD_TYPES.HOY: {
            startUtcDate = zonedDateTimeToUtc(currentZoned.year, currentZoned.month, currentZoned.day, 0, 0, 0, 0, tz);
            endUtcDate = zonedDateTimeToUtc(currentZoned.year, currentZoned.month, currentZoned.day, 23, 59, 59, 999, tz);
            startLocalStr = formatLocalDate(currentZoned.year, currentZoned.month, currentZoned.day);
            endLocalStr = startLocalStr;
            label = `Hoy (${currentZoned.day} de ${MONTH_NAMES_ES[currentZoned.month - 1]} de ${currentZoned.year})`;
            break;
        }

        case NL_PERIOD_TYPES.AYER: {
            const yesterdayUtc = zonedDateTimeToUtc(currentZoned.year, currentZoned.month, currentZoned.day - 1, 12, 0, 0, 0, tz);
            const yParts = getZonedDateParts(yesterdayUtc, tz);
            startUtcDate = zonedDateTimeToUtc(yParts.year, yParts.month, yParts.day, 0, 0, 0, 0, tz);
            endUtcDate = zonedDateTimeToUtc(yParts.year, yParts.month, yParts.day, 23, 59, 59, 999, tz);
            startLocalStr = formatLocalDate(yParts.year, yParts.month, yParts.day);
            endLocalStr = startLocalStr;
            label = `Ayer (${yParts.day} de ${MONTH_NAMES_ES[yParts.month - 1]} de ${yParts.year})`;
            break;
        }

        case NL_PERIOD_TYPES.ESTA_SEMANA: {
            const isoWeekday = getIsoWeekday(currentZoned.year, currentZoned.month, currentZoned.day);
            const daysToMonday = isoWeekday - 1;
            const daysToSunday = 7 - isoWeekday;

            const mondayUtc = zonedDateTimeToUtc(currentZoned.year, currentZoned.month, currentZoned.day - daysToMonday, 0, 0, 0, 0, tz);
            const sundayUtc = zonedDateTimeToUtc(currentZoned.year, currentZoned.month, currentZoned.day + daysToSunday, 23, 59, 59, 999, tz);

            const mParts = getZonedDateParts(mondayUtc, tz);
            const sParts = getZonedDateParts(sundayUtc, tz);

            startUtcDate = mondayUtc;
            endUtcDate = sundayUtc;
            startLocalStr = formatLocalDate(mParts.year, mParts.month, mParts.day);
            endLocalStr = formatLocalDate(sParts.year, sParts.month, sParts.day);
            label = `Esta semana (${mParts.day} al ${sParts.day} de ${MONTH_NAMES_ES[sParts.month - 1]})`;
            break;
        }

        case NL_PERIOD_TYPES.SEMANA_PASADA: {
            const isoWeekday = getIsoWeekday(currentZoned.year, currentZoned.month, currentZoned.day);
            const daysToPrevMonday = isoWeekday - 1 + 7;
            const daysToPrevSunday = daysToPrevMonday - 6;

            const prevMondayUtc = zonedDateTimeToUtc(currentZoned.year, currentZoned.month, currentZoned.day - daysToPrevMonday, 0, 0, 0, 0, tz);
            const prevSundayUtc = zonedDateTimeToUtc(currentZoned.year, currentZoned.month, currentZoned.day - daysToPrevSunday, 23, 59, 59, 999, tz);

            const mParts = getZonedDateParts(prevMondayUtc, tz);
            const sParts = getZonedDateParts(prevSundayUtc, tz);

            startUtcDate = prevMondayUtc;
            endUtcDate = prevSundayUtc;
            startLocalStr = formatLocalDate(mParts.year, mParts.month, mParts.day);
            endLocalStr = formatLocalDate(sParts.year, sParts.month, sParts.day);
            label = `Semana pasada (${mParts.day} al ${sParts.day} de ${MONTH_NAMES_ES[sParts.month - 1]})`;
            break;
        }

        case NL_PERIOD_TYPES.ESTE_MES: {
            const daysInMonth = getDaysInMonth(currentZoned.year, currentZoned.month);
            startUtcDate = zonedDateTimeToUtc(currentZoned.year, currentZoned.month, 1, 0, 0, 0, 0, tz);
            endUtcDate = zonedDateTimeToUtc(currentZoned.year, currentZoned.month, daysInMonth, 23, 59, 59, 999, tz);
            startLocalStr = formatLocalDate(currentZoned.year, currentZoned.month, 1);
            endLocalStr = formatLocalDate(currentZoned.year, currentZoned.month, daysInMonth);
            label = `Este mes (${MONTH_NAMES_ES[currentZoned.month - 1]} ${currentZoned.year})`;
            break;
        }

        case NL_PERIOD_TYPES.MES_PASADO: {
            const prevMonthYear = currentZoned.month === 1 ? currentZoned.year - 1 : currentZoned.year;
            const prevMonth = currentZoned.month === 1 ? 12 : currentZoned.month - 1;
            const daysInPrevMonth = getDaysInMonth(prevMonthYear, prevMonth);

            startUtcDate = zonedDateTimeToUtc(prevMonthYear, prevMonth, 1, 0, 0, 0, 0, tz);
            endUtcDate = zonedDateTimeToUtc(prevMonthYear, prevMonth, daysInPrevMonth, 23, 59, 59, 999, tz);
            startLocalStr = formatLocalDate(prevMonthYear, prevMonth, 1);
            endLocalStr = formatLocalDate(prevMonthYear, prevMonth, daysInPrevMonth);
            label = `Mes pasado (${MONTH_NAMES_ES[prevMonth - 1]} ${prevMonthYear})`;
            break;
        }

        case NL_PERIOD_TYPES.ULTIMOS_N_DIAS: {
            const n = param?.n && param.n > 0 ? param.n : 7;
            const pastDayUtc = zonedDateTimeToUtc(currentZoned.year, currentZoned.month, currentZoned.day - (n - 1), 0, 0, 0, 0, tz);
            const pParts = getZonedDateParts(pastDayUtc, tz);

            startUtcDate = pastDayUtc;
            endUtcDate = zonedDateTimeToUtc(currentZoned.year, currentZoned.month, currentZoned.day, 23, 59, 59, 999, tz);
            startLocalStr = formatLocalDate(pParts.year, pParts.month, pParts.day);
            endLocalStr = formatLocalDate(currentZoned.year, currentZoned.month, currentZoned.day);
            label = `Últimos ${n} días (${startLocalStr} al ${endLocalStr})`;
            break;
        }

        case NL_PERIOD_TYPES.RANGO_EXPLICITO: {
            let sYear = currentZoned.year;
            let sMonth = currentZoned.month;
            let sDay = 1;
            let eYear = currentZoned.year;
            let eMonth = currentZoned.month;
            let eDay = currentZoned.day;

            if (param?.inicio) {
                const sMatch = param.inicio.match(/^(\d{4})-(\d{2})-(\d{2})/);
                if (sMatch) {
                    sYear = Number(sMatch[1]);
                    sMonth = Number(sMatch[2]);
                    sDay = Number(sMatch[3]);
                }
            }
            if (param?.fin) {
                const eMatch = param.fin.match(/^(\d{4})-(\d{2})-(\d{2})/);
                if (eMatch) {
                    eYear = Number(eMatch[1]);
                    eMonth = Number(eMatch[2]);
                    eDay = Number(eMatch[3]);
                }
            }

            startUtcDate = zonedDateTimeToUtc(sYear, sMonth, sDay, 0, 0, 0, 0, tz);
            endUtcDate = zonedDateTimeToUtc(eYear, eMonth, eDay, 23, 59, 59, 999, tz);
            startLocalStr = formatLocalDate(sYear, sMonth, sDay);
            endLocalStr = formatLocalDate(eYear, eMonth, eDay);
            label = `Periodo del ${startLocalStr} al ${endLocalStr}`;
            break;
        }

        default: {
            const daysInMonth = getDaysInMonth(currentZoned.year, currentZoned.month);
            startUtcDate = zonedDateTimeToUtc(currentZoned.year, currentZoned.month, 1, 0, 0, 0, 0, tz);
            endUtcDate = zonedDateTimeToUtc(currentZoned.year, currentZoned.month, daysInMonth, 23, 59, 59, 999, tz);
            startLocalStr = formatLocalDate(currentZoned.year, currentZoned.month, 1);
            endLocalStr = formatLocalDate(currentZoned.year, currentZoned.month, daysInMonth);
            label = `Este mes (${MONTH_NAMES_ES[currentZoned.month - 1]} ${currentZoned.year})`;
            break;
        }
    }

    let previousPeriod: ResolvedPeriod['previousPeriod'] | undefined;

    if (options?.compareTo) {
        if (options.compareTo === NL_COMPARE_TO_DIMENSIONS.PERIODO_ANTERIOR) {
            const durationMs = endUtcDate.getTime() - startUtcDate.getTime() + 1;
            const prevEndUtc = new Date(startUtcDate.getTime() - 1);
            const prevStartUtc = new Date(prevEndUtc.getTime() - durationMs + 1);
            previousPeriod = {
                startUtc: prevStartUtc.toISOString(),
                endUtc: prevEndUtc.toISOString(),
                label: 'Periodo inmediatamente anterior',
            };
        } else if (options.compareTo === NL_COMPARE_TO_DIMENSIONS.MISMO_PERIODO_MES_PASADO) {
            const sParts = getZonedDateParts(startUtcDate, tz);
            const eParts = getZonedDateParts(endUtcDate, tz);
            const prevYear = sParts.month === 1 ? sParts.year - 1 : sParts.year;
            const prevMonth = sParts.month === 1 ? 12 : sParts.month - 1;
            const maxDays = getDaysInMonth(prevYear, prevMonth);
            const pStartDay = Math.min(sParts.day, maxDays);
            const pEndDay = Math.min(eParts.day, maxDays);

            const pStartUtc = zonedDateTimeToUtc(prevYear, prevMonth, pStartDay, 0, 0, 0, 0, tz);
            const pEndUtc = zonedDateTimeToUtc(prevYear, prevMonth, pEndDay, 23, 59, 59, 999, tz);
            previousPeriod = {
                startUtc: pStartUtc.toISOString(),
                endUtc: pEndUtc.toISOString(),
                label: `Mismo periodo en ${MONTH_NAMES_ES[prevMonth - 1]} ${prevYear}`,
            };
        }
    }

    return {
        type,
        startUtc: startUtcDate.toISOString(),
        endUtc: endUtcDate.toISOString(),
        startLocal: startLocalStr,
        endLocal: endLocalStr,
        label,
        timezone: tz,
        previousPeriod,
    };
}
