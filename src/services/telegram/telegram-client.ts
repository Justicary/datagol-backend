import { z } from 'zod';
import { fetchWithTimeout } from '../llm/http.js';
import { checkAndRecordHit } from '../../lib/rate-limiter.js';

export const TELEGRAM_API_TIMEOUT_MS = 8_000;
const TELEGRAM_API_BASE = 'https://api.telegram.org';

// Límite conservador por chat: máx. 20 mensajes por minuto hacia un mismo chat
const PER_CHAT_LIMIT_PER_MIN = 20;
const ONE_MINUTE_MS = 60_000;

const getMeResponseSchema = z.object({
    ok: z.literal(true),
    result: z.object({
        id: z.number().int(),
        is_bot: z.literal(true),
        first_name: z.string(),
        username: z.string(),
    }),
});

const booleanResultResponseSchema = z.object({
    ok: z.literal(true),
    result: z.boolean(),
    description: z.string().optional(),
});

const sendMessageResponseSchema = z.object({
    ok: z.literal(true),
    result: z.object({
        message_id: z.number().int(),
    }),
});

const errorResponseSchema = z.object({
    ok: z.literal(false),
    error_code: z.number().int().optional(),
    description: z.string().optional(),
    parameters: z
        .object({
            retry_after: z.number().int().optional(),
        })
        .optional(),
});

export type TelegramClientErrorKind =
    | 'invalid_token'
    | 'rate_limited'
    | 'bad_request'
    | 'network_error'
    | 'unknown';

export interface TelegramBotInfo {
    id: number;
    username: string;
    firstName: string;
}

export type GetMeResult =
    | { ok: true; bot: TelegramBotInfo }
    | { ok: false; kind: TelegramClientErrorKind; message: string };

export type WebhookOperationResult =
    | { ok: true }
    | { ok: false; kind: TelegramClientErrorKind; message: string };

export type SendMessageResult =
    | { ok: true; messageId: number }
    | { ok: false; kind: TelegramClientErrorKind; message: string; retryAfterSeconds?: number };

/**
 * Redacta cualquier aparición del botToken en un mensaje de error antes de
 * devolverlo o registrarlo en bitácora.
 */
export function redactBotTokenFromText(text: string, botToken: string): string {
    if (!text || !botToken) return text;
    return text.split(botToken).join('[REDACTED_BOT_TOKEN]');
}

function classifyTelegramError(statusCode: number): TelegramClientErrorKind {
    if (statusCode === 401 || statusCode === 404) return 'invalid_token';
    if (statusCode === 429) return 'rate_limited';
    if (statusCode === 400 || statusCode === 403) return 'bad_request';
    return 'unknown';
}

const CLIENT_ERROR_MESSAGES: Record<TelegramClientErrorKind, string> = {
    invalid_token:
        'El token del Bot de Telegram es inválido o fue revocado en @BotFather. Verifica el token e inténtalo de nuevo.',
    rate_limited:
        'Telegram aplicó un límite temporal de envío de mensajes. Intenta de nuevo en unos segundos.',
    bad_request:
        'Telegram rechazó la operación solicitada. Verifica la configuración del bot y del webhook.',
    network_error:
        'No se pudo contactar a la API de Telegram en este momento. Intenta de nuevo en unos instantes.',
    unknown:
        'La API de Telegram devolvió una respuesta inesperada.',
};

/**
 * Verifica el token del bot contra `getMe` de Telegram Bot API.
 */
export async function getTelegramBotMe(
    botToken: string,
    timeoutMs: number = TELEGRAM_API_TIMEOUT_MS
): Promise<GetMeResult> {
    const url = `${TELEGRAM_API_BASE}/bot${botToken}/getMe`;
    try {
        const res = await fetchWithTimeout(
            url,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            },
            timeoutMs
        );

        const json: unknown = await res.json().catch(() => null);
        if (res.ok) {
            const parsed = getMeResponseSchema.safeParse(json);
            if (parsed.success) {
                return {
                    ok: true,
                    bot: {
                        id: parsed.data.result.id,
                        username: parsed.data.result.username,
                        firstName: parsed.data.result.first_name,
                    },
                };
            }
        }

        const kind = classifyTelegramError(res.status);
        return {
            ok: false,
            kind,
            message: CLIENT_ERROR_MESSAGES[kind],
        };
    } catch {
        return {
            ok: false,
            kind: 'network_error',
            message: CLIENT_ERROR_MESSAGES.network_error,
        };
    }
}

export interface SetTelegramWebhookParams {
    url: string;
    secretToken: string;
}

/**
 * Registra el webhook HTTPS del bot en Telegram junto con su `secret_token`
 * para que Telegram envíe `X-Telegram-Bot-Api-Secret-Token` en cada Update.
 */
export async function setTelegramWebhook(
    botToken: string,
    params: SetTelegramWebhookParams,
    timeoutMs: number = TELEGRAM_API_TIMEOUT_MS
): Promise<WebhookOperationResult> {
    const endpoint = `${TELEGRAM_API_BASE}/bot${botToken}/setWebhook`;
    try {
        const res = await fetchWithTimeout(
            endpoint,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: params.url,
                    secret_token: params.secretToken,
                    allowed_updates: ['message'],
                    drop_pending_updates: false,
                }),
            },
            timeoutMs
        );

        const json: unknown = await res.json().catch(() => null);
        if (res.ok) {
            const parsed = booleanResultResponseSchema.safeParse(json);
            if (parsed.success && parsed.data.result === true) {
                return { ok: true };
            }
        }

        const kind = classifyTelegramError(res.status);
        return {
            ok: false,
            kind,
            message: CLIENT_ERROR_MESSAGES[kind],
        };
    } catch {
        return {
            ok: false,
            kind: 'network_error',
            message: CLIENT_ERROR_MESSAGES.network_error,
        };
    }
}

/**
 * Elimina el webhook registrado en Telegram para el bot.
 */
export async function deleteTelegramWebhook(
    botToken: string,
    timeoutMs: number = TELEGRAM_API_TIMEOUT_MS
): Promise<WebhookOperationResult> {
    const endpoint = `${TELEGRAM_API_BASE}/bot${botToken}/deleteWebhook`;
    try {
        const res = await fetchWithTimeout(
            endpoint,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ drop_pending_updates: false }),
            },
            timeoutMs
        );

        const json: unknown = await res.json().catch(() => null);
        if (res.ok) {
            const parsed = booleanResultResponseSchema.safeParse(json);
            if (parsed.success && parsed.data.result === true) {
                return { ok: true };
            }
        }

        const kind = classifyTelegramError(res.status);
        return {
            ok: false,
            kind,
            message: CLIENT_ERROR_MESSAGES[kind],
        };
    } catch {
        return {
            ok: false,
            kind: 'network_error',
            message: CLIENT_ERROR_MESSAGES.network_error,
        };
    }
}

export interface SendTelegramMessageParams {
    chatId: number;
    text: string;
    parseMode?: 'HTML';
}

/**
 * Envía un mensaje HTML a un chat de Telegram respetando límites de tasa por chat.
 */
export async function sendTelegramMessage(
    botToken: string,
    params: SendTelegramMessageParams,
    timeoutMs: number = TELEGRAM_API_TIMEOUT_MS
): Promise<SendMessageResult> {
    const rateCheck = checkAndRecordHit(`tg_out_chat:${params.chatId}`, PER_CHAT_LIMIT_PER_MIN, ONE_MINUTE_MS);
    if (!rateCheck.ok) {
        return {
            ok: false,
            kind: 'rate_limited',
            message: CLIENT_ERROR_MESSAGES.rate_limited,
        };
    }

    const endpoint = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
    try {
        const res = await fetchWithTimeout(
            endpoint,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: params.chatId,
                    text: params.text,
                    parse_mode: params.parseMode ?? 'HTML',
                    disable_web_page_preview: true,
                }),
            },
            timeoutMs
        );

        const json: unknown = await res.json().catch(() => null);
        if (res.ok) {
            const parsed = sendMessageResponseSchema.safeParse(json);
            if (parsed.success) {
                return {
                    ok: true,
                    messageId: parsed.data.result.message_id,
                };
            }
        }

        const errParsed = errorResponseSchema.safeParse(json);
        const retryAfterSeconds = errParsed.success ? errParsed.data.parameters?.retry_after : undefined;
        const kind = classifyTelegramError(res.status);

        return {
            ok: false,
            kind,
            message: CLIENT_ERROR_MESSAGES[kind],
            retryAfterSeconds,
        };
    } catch {
        return {
            ok: false,
            kind: 'network_error',
            message: CLIENT_ERROR_MESSAGES.network_error,
        };
    }
}

/**
 * Envía una lista de fragmentos HTML en orden secuencial.
 */
export async function sendTelegramHtmlChunks(
    botToken: string,
    chatId: number,
    chunks: readonly string[],
    timeoutMs: number = TELEGRAM_API_TIMEOUT_MS
): Promise<{ ok: boolean; messageIds: number[]; error?: string }> {
    const messageIds: number[] = [];

    for (const chunk of chunks) {
        const res = await sendTelegramMessage(
            botToken,
            { chatId, text: chunk, parseMode: 'HTML' },
            timeoutMs
        );
        if (!res.ok) {
            return { ok: false, messageIds, error: res.message };
        }
        messageIds.push(res.messageId);
    }

    return { ok: true, messageIds };
}
