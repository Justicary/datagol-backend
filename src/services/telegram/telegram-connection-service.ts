import crypto from 'crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import { validateEnv } from '../../config/env.js';
import { getSecret, setSecret, listSecretStatus } from '../secret-service.js';
import { SECRET_KEYS } from '../../types/secret-keys.js';
import type { TelegramConnectionRecord, TelegramConnectionStatus } from '../../types/telegram.js';
import {
    getTelegramBotMe,
    setTelegramWebhook,
    deleteTelegramWebhook,
} from './telegram-client.js';

export interface TelegramConnectionPublicStatus {
    connected: boolean;
    botId: number | null;
    botUsername: string | null;
    botFirstName: string | null;
    webhookRegisteredAt: string | null;
    status: TelegramConnectionStatus | null;
    lastError: string | null;
    hasBotTokenInVault: boolean;
    hasWebhookSecretInVault: boolean;
}

export class TelegramConnectionError extends Error {
    readonly statusCode: number;
    constructor(message: string, statusCode: number = 400) {
        super(message);
        this.name = 'TelegramConnectionError';
        this.statusCode = statusCode;
    }
}

/**
 * Consulta el estado público de la conexión de Telegram de una organización.
 * Jamás devuelve el bot_token, el webhook_secret ni el webhook_token de enrutamiento.
 */
export async function getTelegramConnectionStatus(
    organizationId: string
): Promise<TelegramConnectionPublicStatus> {
    const [{ data: conn }, secretStatuses] = await Promise.all([
        supabaseAdmin
            .from('telegram_connections')
            .select(
                'id, organization_id, telegram_bot_id, bot_username, bot_first_name, webhook_registered_at, status, last_error'
            )
            .eq('organization_id', organizationId)
            .maybeSingle(),
        listSecretStatus(organizationId),
    ]);

    const hasBotTokenInVault = Boolean(secretStatuses[SECRET_KEYS.TELEGRAM_BOT_TOKEN]?.present);
    const hasWebhookSecretInVault = Boolean(secretStatuses[SECRET_KEYS.TELEGRAM_WEBHOOK_SECRET]?.present);

    if (!conn) {
        return {
            connected: false,
            botId: null,
            botUsername: null,
            botFirstName: null,
            webhookRegisteredAt: null,
            status: null,
            lastError: null,
            hasBotTokenInVault,
            hasWebhookSecretInVault,
        };
    }

    return {
        connected: conn.status === 'active' && hasBotTokenInVault,
        botId: Number(conn.telegram_bot_id),
        botUsername: conn.bot_username as string,
        botFirstName: (conn.bot_first_name as string | null) ?? null,
        webhookRegisteredAt: (conn.webhook_registered_at as string | null) ?? null,
        status: conn.status as TelegramConnectionStatus,
        lastError: (conn.last_error as string | null) ?? null,
        hasBotTokenInVault,
        hasWebhookSecretInVault,
    };
}

/**
 * Valida un Bot Token contra `getMe` de Telegram, guarda el token y un
 * `webhook_secret` criptográfico en Supabase Vault, y crea/actualiza la fila
 * en `telegram_connections`.
 */
export async function upsertTelegramConnection(
    organizationId: string,
    botToken: string
): Promise<TelegramConnectionPublicStatus> {
    const trimmedToken = botToken.trim();
    const meResult = await getTelegramBotMe(trimmedToken);
    if (!meResult.ok) {
        throw new TelegramConnectionError(meResult.message, 400);
    }

    // Verificar que este bot no esté asignado a otra organización
    const { data: existingBotOwner } = await supabaseAdmin
        .from('telegram_connections')
        .select('organization_id')
        .eq('telegram_bot_id', meResult.bot.id)
        .maybeSingle();

    if (existingBotOwner && existingBotOwner.organization_id !== organizationId) {
        throw new TelegramConnectionError(
            'Este Bot de Telegram ya está vinculado a otra organización.',
            409
        );
    }

    const webhookSecret = crypto.randomBytes(32).toString('hex');

    const savedToken = await setSecret(organizationId, SECRET_KEYS.TELEGRAM_BOT_TOKEN, trimmedToken);
    const savedSecret = await setSecret(organizationId, SECRET_KEYS.TELEGRAM_WEBHOOK_SECRET, webhookSecret);

    if (!savedToken || !savedSecret) {
        throw new TelegramConnectionError(
            'No se pudieron guardar las credenciales del Bot en la bóveda segura.',
            500
        );
    }

    const webhookToken = crypto.randomBytes(32).toString('hex');

    const { error: upsertErr } = await supabaseAdmin
        .from('telegram_connections')
        .upsert(
            {
                organization_id: organizationId,
                telegram_bot_id: meResult.bot.id,
                bot_username: meResult.bot.username,
                bot_first_name: meResult.bot.firstName,
                webhook_token: webhookToken,
                status: 'active',
                last_error: null,
            },
            { onConflict: 'organization_id' }
        );

    if (upsertErr) {
        throw new TelegramConnectionError(
            'Error al registrar la conexión del Bot de Telegram.',
            500
        );
    }

    return getTelegramConnectionStatus(organizationId);
}

/**
 * Valida las credenciales actuales del Bot (o un token proporcionado) contra `getMe`.
 */
export async function validateTelegramConnection(
    organizationId: string,
    candidateBotToken?: string
): Promise<{ valid: boolean; bot?: { id: number; username: string; firstName: string }; error?: string }> {
    const tokenToTest =
        candidateBotToken?.trim() || (await getSecret(organizationId, SECRET_KEYS.TELEGRAM_BOT_TOKEN));

    if (!tokenToTest) {
        return {
            valid: false,
            error: 'No hay un token de Bot de Telegram configurado para esta organización.',
        };
    }

    const meResult = await getTelegramBotMe(tokenToTest);
    if (!meResult.ok) {
        return {
            valid: false,
            error: meResult.message,
        };
    }

    return {
        valid: true,
        bot: meResult.bot,
    };
}

/**
 * Registra el webhook HTTPS en Telegram para el bot de la organización.
 * Exige que `BACKEND_WEBHOOK_URL` esté configurada en el entorno.
 */
export async function registerTelegramConnectionWebhook(
    organizationId: string
): Promise<TelegramConnectionPublicStatus> {
    const env = validateEnv();
    if (!env.BACKEND_WEBHOOK_URL) {
        throw new TelegramConnectionError(
            'La variable de entorno BACKEND_WEBHOOK_URL no está configurada en el servidor. No es posible registrar un webhook roto en Telegram.',
            400
        );
    }

    const { data: conn, error: connErr } = await supabaseAdmin
        .from('telegram_connections')
        .select('*')
        .eq('organization_id', organizationId)
        .maybeSingle();

    if (connErr || !conn) {
        throw new TelegramConnectionError(
            'Primero debes configurar y guardar el token del Bot de Telegram.',
            404
        );
    }

    const connection = conn as TelegramConnectionRecord;
    const botToken = await getSecret(organizationId, SECRET_KEYS.TELEGRAM_BOT_TOKEN);
    let webhookSecret = await getSecret(organizationId, SECRET_KEYS.TELEGRAM_WEBHOOK_SECRET);

    if (!botToken) {
        throw new TelegramConnectionError(
            'No se encontró el token del Bot en la bóveda de secretos.',
            400
        );
    }

    if (!webhookSecret) {
        webhookSecret = crypto.randomBytes(32).toString('hex');
        const ok = await setSecret(organizationId, SECRET_KEYS.TELEGRAM_WEBHOOK_SECRET, webhookSecret);
        if (!ok) {
            throw new TelegramConnectionError('No se pudo generar el secreto de verificación del webhook.', 500);
        }
    }

    const baseUrl = env.BACKEND_WEBHOOK_URL.replace(/\/+$/, '');
    const webhookUrl = `${baseUrl}/webhooks/telegram/${connection.webhook_token}`;

    const setRes = await setTelegramWebhook(botToken, {
        url: webhookUrl,
        secretToken: webhookSecret,
    });

    if (!setRes.ok) {
        await supabaseAdmin
            .from('telegram_connections')
            .update({ status: 'error', last_error: setRes.message })
            .eq('organization_id', organizationId);

        throw new TelegramConnectionError(setRes.message, 502);
    }

    await supabaseAdmin
        .from('telegram_connections')
        .update({
            status: 'active',
            webhook_registered_at: new Date().toISOString(),
            last_error: null,
        })
        .eq('organization_id', organizationId);

    return getTelegramConnectionStatus(organizationId);
}

/**
 * Desconecta el Bot de Telegram de la organización, desregistra su webhook y
 * limpia las conversaciones y vínculos activos.
 */
export async function deleteTelegramConnection(organizationId: string): Promise<void> {
    const botToken = await getSecret(organizationId, SECRET_KEYS.TELEGRAM_BOT_TOKEN);
    if (botToken) {
        await deleteTelegramWebhook(botToken).catch(() => null);
    }

    await supabaseAdmin
        .from('telegram_conversations')
        .delete()
        .eq('organization_id', organizationId);

    await supabaseAdmin
        .from('telegram_link_tokens')
        .delete()
        .eq('organization_id', organizationId);

    await supabaseAdmin
        .from('telegram_identities')
        .update({ status: 'revoked', revoked_at: new Date().toISOString() })
        .eq('organization_id', organizationId)
        .eq('status', 'active');

    await supabaseAdmin
        .from('telegram_connections')
        .delete()
        .eq('organization_id', organizationId);
}
