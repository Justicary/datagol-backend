import { escapeHtml } from '../../lib/html-escape.js';
import type { AskReportResponse, AskReportSuccessResponse } from '../../types/natural-reports.js';
import { formatToZonedTime, DEFAULT_TIMEZONE } from '../reports/nl-dimensions.js';

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
export const MAX_RESULT_DIGEST_LENGTH = 500;

export const TELEGRAM_USER_MESSAGES = {
    UNAUTHORIZED:
        '🔒 No tienes una cuenta vinculada o autorizada para este bot. Solicita un enlace de vinculación en el panel de administración.',
    LINK_SUCCESS:
        '✅ <b>Cuenta vinculada correctamente.</b>\nYa puedes solicitar reportes e información de negocio en español (por ejemplo: <i>"¿Cuántas citas tuvimos esta semana?"</i> o <i>"¿Cuál fue el costo total de este mes?"</i>).',
    LINK_INVALID:
        '⚠️ El enlace de vinculación no es válido, ya fue utilizado o expiró. Genera uno nuevo desde el panel de administración.',
    LINK_RATE_LIMITED:
        '⏳ Has realizado demasiados intentos de vinculación. Espera un minuto antes de volver a intentarlo.',
    HELP:
        '📊 <b>Asistente Ejecutivo Datagol</b>\n\nPuedes hacer preguntas en español sobre:\n• <b>Agenda:</b> citas de hoy, por estado o sin desenlace.\n• <b>Pendientes:</b> prospectos abiertos, calientes o seguimientos vencidos.\n• <b>Captación:</b> prospectos nuevos, conversaciones y origen.\n• <b>Costos:</b> gasto total, por canal, por prospecto o por cita.\n• <b>Resultados:</b> ventas ganadas, cumplimiento y conversión.\n• <b>Correos:</b> enviados, con error o resumen de recibidos.\n\nComandos:\n/nuevo — Reiniciar el contexto de la conversación\n/ayuda — Mostrar esta guía',
    CONTEXT_CLEARED:
        '🧹 Contexto de conversación reiniciado. Tu siguiente pregunta se procesará desde cero.',
    EMPTY_QUESTION:
        'Por favor envía una pregunta en texto (por ejemplo: <i>"¿Cuántos prospectos nuevos llegaron hoy?"</i>).',
    EXECUTION_ERROR:
        '⚠️ No fue posible procesar la consulta en este momento. Intenta de nuevo en unos instantes.',
} as const;

/**
 * Detecta comandos de ayuda (`/start`, `/ayuda`, `/help`) o preguntas en lenguaje
 * natural sobre qué tipo de consultas o reportes puede responder el asistente.
 */
export function isTelegramHelpQuery(rawText: string): boolean {
    const normalized = rawText
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

    if (
        normalized === '/start' ||
        normalized === '/ayuda' ||
        normalized === '/help' ||
        normalized === 'ayuda' ||
        normalized === 'help'
    ) {
        return true;
    }

    return (
        /(?:que|cuales)\s+(?:tipo\s+de\s+)?(?:preguntas|consultas|reportes|informacion|cosas|datos)\s+(?:te\s+)?(?:puedo|podemos|se\s+pueden|puedes|sabes)\s+(?:hacer|preguntar|pedir|consultar|contestar|responder)/i.test(
            normalized
        ) ||
        /(?:que\s+puedes|que\s+sabes)\s+(?:hacer|contestar|responder|decirme)/i.test(normalized) ||
        /(?:en\s+que|como)\s+(?:me\s+)?puedes\s+ayudar/i.test(normalized)
    );
}

function formatKeyLabel(key: string): string {
    const clean = key
        .replace(/([A-Z])/g, ' $1')
        .replace(/_/g, ' ')
        .trim();
    return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function formatScalarValue(val: unknown, timeZone?: string): string {
    if (val === null || val === undefined || val === '') return '—';
    if (typeof val === 'boolean') return val ? 'Sí' : 'No';
    if (typeof val === 'number') {
        return Number.isInteger(val) ? val.toLocaleString('es-MX') : val.toFixed(2);
    }
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
            return formatToZonedTime(trimmed, timeZone);
        }
        return trimmed;
    }
    if (typeof val === 'object') {
        return JSON.stringify(val);
    }
    return String(val);
}

function renderDataBlock(shape: string, data: unknown, timeZone?: string): string {
    if (data === null || data === undefined) {
        return '<i>Sin datos para este periodo.</i>';
    }

    if (shape === 'numero' && typeof data === 'object' && !Array.isArray(data)) {
        const entries = Object.entries(data as Record<string, unknown>);
        if (entries.length === 0) return '<i>Sin datos registrados.</i>';
        return entries
            .map(([k, v]) => {
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                    const sub = Object.entries(v as Record<string, unknown>)
                        .map(([sk, sv]) => `${escapeHtml(formatKeyLabel(sk))}: ${escapeHtml(formatScalarValue(sv, timeZone))}`)
                        .join(', ');
                    return `• <b>${escapeHtml(formatKeyLabel(k))}:</b> ${sub}`;
                }
                return `• <b>${escapeHtml(formatKeyLabel(k))}:</b> <code>${escapeHtml(formatScalarValue(v, timeZone))}</code>`;
            })
            .join('\n');
    }

    const rows: unknown[] = Array.isArray(data)
        ? data
        : typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>).items)
          ? ((data as Record<string, unknown>).items as unknown[])
          : typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>).rows)
            ? ((data as Record<string, unknown>).rows as unknown[])
            : typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>).filas)
              ? ((data as Record<string, unknown>).filas as unknown[])
              : typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>).prospectos)
                ? ((data as Record<string, unknown>).prospectos as unknown[])
                : [];

    if (Array.isArray(data) || rows.length > 0) {
        const list = Array.isArray(data) ? data : rows;
        if (list.length === 0) {
            return '<i>No se encontraron registros en el periodo consultado.</i>';
        }
        return list
            .map((item, idx) => {
                if (item && typeof item === 'object') {
                    const fields = Object.entries(item as Record<string, unknown>)
                        .filter(([, v]) => v !== null && v !== undefined && v !== '')
                        .map(([k, v]) => `<b>${escapeHtml(formatKeyLabel(k))}:</b> ${escapeHtml(formatScalarValue(v, timeZone))}`)
                        .join(' | ');
                    return `${idx + 1}. ${fields}`;
                }
                return `${idx + 1}. ${escapeHtml(formatScalarValue(item, timeZone))}`;
            })
            .join('\n');
    }

    if (typeof data === 'object') {
        const entries = Object.entries(data as Record<string, unknown>);
        return entries
            .map(([k, v]) => `• <b>${escapeHtml(formatKeyLabel(k))}:</b> ${escapeHtml(formatScalarValue(v, timeZone))}`)
            .join('\n');
    }

    return escapeHtml(formatScalarValue(data, timeZone));
}

/**
 * Convierte la respuesta estructurada del arnés en HTML seguro para Telegram.
 */
export function formatHarnessResponseForTelegram(response: AskReportResponse): string {
    if (response.status === 'requiere_aclaracion') {
        return [
            `🤔 <b>Necesito una aclaración</b>`,
            escapeHtml(response.preguntaAclaracion),
        ].join('\n\n');
    }

    if (response.status === 'no_resuelta') {
        return [
            `ℹ️ <b>Consulta fuera del catálogo actual</b>`,
            escapeHtml(response.reason),
        ].join('\n\n');
    }

    const timezone =
        'period' in response &&
        response.period &&
        typeof (response.period as { timezone?: unknown }).timezone === 'string'
            ? (response.period as { timezone: string }).timezone
            : DEFAULT_TIMEZONE;

    const parts: string[] = [];
    parts.push(`📊 <b>${escapeHtml(response.interpretation)}</b>`);
    parts.push(`🗓 <i>Periodo: ${escapeHtml(response.period.label)}</i>`);

    if (response.narrative) {
        parts.push(escapeHtml(response.narrative));
    }

    parts.push(renderDataBlock(response.shape, response.data, timezone));

    if (response.warnings && response.warnings.length > 0) {
        const warningsBlock = response.warnings
            .map((w) => `⚠️ <i>${escapeHtml(w)}</i>`)
            .join('\n');
        parts.push(warningsBlock);
    }

    return parts.join('\n\n');
}

/**
 * Divide un mensaje HTML en fragmentos `<= maxLength` caracteres respetando
 * fronteras de párrafo (`\n\n`), línea (`\n`) o espacio, sin partir nunca
 * una etiqueta HTML abierta (`<b>`, `<i>`, `<code>`) ni una entidad `&...;`.
 */
export function splitTelegramHtmlMessage(
    html: string,
    maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH
): string[] {
    const trimmed = html.trim();
    if (trimmed.length <= maxLength) {
        return [trimmed];
    }

    // Reservar 12 caracteres para el prefijo "(N/M)\n"
    const effectiveMax = Math.max(64, maxLength - 12);
    const lines = trimmed.split('\n');
    const rawChunks: string[] = [];
    let current = '';

    for (const line of lines) {
        const candidate = current ? `${current}\n${line}` : line;
        if (candidate.length <= effectiveMax) {
            current = candidate;
            continue;
        }

        if (current) {
            rawChunks.push(current);
            current = '';
        }

        if (line.length <= effectiveMax) {
            current = line;
            continue;
        }

        // Si una sola línea supera effectiveMax, dividir por palabras (espacios)
        // fuera de etiquetas HTML
        let remaining = line;
        while (remaining.length > effectiveMax) {
            let cutIndex = remaining.lastIndexOf(' ', effectiveMax);
            if (cutIndex <= 0) {
                cutIndex = effectiveMax;
            }
            // Evitar cortar dentro de una etiqueta <...> o entidad &...;
            const lastOpenBracket = remaining.lastIndexOf('<', cutIndex);
            const lastCloseBracket = remaining.lastIndexOf('>', cutIndex);
            if (lastOpenBracket > lastCloseBracket) {
                cutIndex = lastOpenBracket;
            }
            const chunkPart = remaining.slice(0, cutIndex).trim();
            if (chunkPart) {
                rawChunks.push(chunkPart);
            }
            remaining = remaining.slice(cutIndex).trim();
        }
        if (remaining) {
            current = remaining;
        }
    }

    if (current) {
        rawChunks.push(current);
    }

    if (rawChunks.length <= 1) {
        return rawChunks;
    }

    const total = rawChunks.length;
    return rawChunks.map((chunk, i) => `<b>(${i + 1}/${total})</b>\n${chunk}`);
}

/**
 * Construye un resumen acotado (`<= 500` caracteres) del resultado para
 * almacenarlo en `telegram_conversations.context` sin guardar el dataset completo.
 */
export function buildResultDigest(response: AskReportSuccessResponse): string {
    const base = response.narrative
        ? `${response.interpretation} (${response.period.label}): ${response.narrative}`
        : `${response.interpretation} (${response.period.label}) — shape=${response.shape}`;

    if (base.length <= MAX_RESULT_DIGEST_LENGTH) {
        return base;
    }
    return `${base.slice(0, MAX_RESULT_DIGEST_LENGTH - 3)}...`;
}
