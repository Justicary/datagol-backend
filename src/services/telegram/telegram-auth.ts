import { FastifyInstance } from 'fastify';
import { getSecret } from '../secret-service.js';
import { SECRET_KEYS } from '../../types/secret-keys.js';
import { timingSafeEqualStrings } from '../../lib/timing-safe.js';

export type TelegramWebhookAuthResult =
    | { ok: true; organizationId: string; connectionId: string }
    | {
          ok: false;
          statusCode: 401 | 403;
          reason: 'invalid_webhook_token' | 'invalid_secret_header' | 'organization_suspended';
          message: string;
      };

/**
 * Resuelve la organización de un webhook entrante de Telegram y autentica
 * la cabecera `X-Telegram-Bot-Api-Secret-Token` en tiempo constante.
 *
 * Orden de seguridad obligatorio (AGENTS.md §4 y §5):
 *   1. `:webhookToken` en `telegram_connections` resuelve la organización
 *      ANTES de inspeccionar cualquier campo del cuerpo.
 *   2. `X-Telegram-Bot-Api-Secret-Token` se compara en tiempo constante
 *      contra `telegram_webhook_secret` almacenado en Supabase Vault.
 *   3. `organizations.status` se verifica SOLO DESPUÉS de autenticar el
 *      secreto para no revelar a un atacante no autenticado si la
 *      organización existe o está suspendida.
 */
export async function resolveAndAuthenticateTelegramWebhook(
    fastify: FastifyInstance,
    webhookToken: string,
    secretHeader: string | undefined
): Promise<TelegramWebhookAuthResult> {
    if (!webhookToken || webhookToken.trim() === '') {
        return {
            ok: false,
            statusCode: 401,
            reason: 'invalid_webhook_token',
            message: 'Token de webhook de Telegram inválido',
        };
    }

    const { data: conn, error: connErr } = await fastify.supabaseAdmin
        .from('telegram_connections')
        .select('id, organization_id, status')
        .eq('webhook_token', webhookToken)
        .maybeSingle();

    if (connErr || !conn || conn.status === 'disabled') {
        return {
            ok: false,
            statusCode: 401,
            reason: 'invalid_webhook_token',
            message: 'Token de webhook de Telegram inválido',
        };
    }

    const organizationId = conn.organization_id as string;
    const expectedSecret = await getSecret(organizationId, SECRET_KEYS.TELEGRAM_WEBHOOK_SECRET);

    if (!expectedSecret || !secretHeader || !timingSafeEqualStrings(secretHeader, expectedSecret)) {
        return {
            ok: false,
            statusCode: 401,
            reason: 'invalid_secret_header',
            message: 'Firma secreta de Telegram inválida o ausente',
        };
    }

    const { data: org, error: orgErr } = await fastify.supabaseAdmin
        .from('organizations')
        .select('id, status')
        .eq('id', organizationId)
        .maybeSingle();

    if (orgErr || !org || org.status === 'suspended') {
        return {
            ok: false,
            statusCode: 403,
            reason: 'organization_suspended',
            message: 'Esta organización tiene su implementación suspendida.',
        };
    }

    return {
        ok: true,
        organizationId,
        connectionId: conn.id as string,
    };
}
