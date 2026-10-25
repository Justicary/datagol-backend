import { FastifyInstance } from 'fastify';
import { getSecret } from '../services/secret-service.js';
import { isFeatureEnabled } from '../services/entitlements.js';
import { SECRET_KEYS } from '../types/secret-keys.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import type { TelegramUpdatePayload } from '../schemas/telegram.js';
import {
    authorizeTelegramMessageSender,
    redeemTelegramStartToken,
} from '../services/telegram/telegram-identity-service.js';
import {
    getActiveConversationContext,
    appendConversationTurn,
    clearConversationContext,
    recordTelegramMessage,
} from '../services/telegram/telegram-conversation-service.js';
import {
    formatHarnessResponseForTelegram,
    splitTelegramHtmlMessage,
    buildResultDigest,
    isTelegramHelpQuery,
    TELEGRAM_USER_MESSAGES,
} from '../services/telegram/formatter.js';
import {
    sendTelegramMessage,
    sendTelegramHtmlChunks,
} from '../services/telegram/telegram-client.js';
import { askHarness, NaturalReportsError } from '../services/harness/ask-harness.js';
import type { NlPeriodParam } from '../schemas/natural-reports.js';

export const TELEGRAM_PROCESS_UPDATE_QUEUE = 'telegram-process-update';

export interface ProcessTelegramUpdateJobData {
    organizationId: string;
    webhookEventId: string;
    update: TelegramUpdatePayload;
}

async function markWebhookProcessed(
    fastify: FastifyInstance,
    webhookEventId: string,
    errorMsg?: string
): Promise<void> {
    if (!webhookEventId) return;
    await fastify.supabaseAdmin
        .from('webhook_events')
        .update({
            processed_at: new Date().toISOString(),
            ...(errorMsg ? { error: errorMsg } : {}),
        })
        .eq('id', webhookEventId);
}

/**
 * Ejecuta el procesamiento diferido de un Update de Telegram con re-verificación
 * completa de seguridad (AGENTS.md §16: verificar la feature y permisos dentro
 * del job antes de ejecutar el efecto).
 */
export async function processTelegramUpdateJob(
    fastify: FastifyInstance,
    data: ProcessTelegramUpdateJobData
): Promise<void> {
    const { organizationId, webhookEventId, update } = data;
    const message = update.message;

    if (!message || message.chat.type !== 'private' || !message.from || message.from.is_bot) {
        await markWebhookProcessed(fastify, webhookEventId);
        return;
    }

    const telegramChatId = message.chat.id;
    const telegramUserId = message.from.id;
    const rawText = (message.text ?? '').trim();

    const botToken = await getSecret(organizationId, SECRET_KEYS.TELEGRAM_BOT_TOKEN);
    if (!botToken) {
        fastify.log.warn(
            {
                organization_id: organizationId,
                telegram_update_id: update.update_id,
                telegram_chat_id: telegramChatId,
                telegram_user_id: telegramUserId,
            },
            '[TelegramJob] Bot token ausente en Vault; no se puede procesar el mensaje'
        );
        await markWebhookProcessed(fastify, webhookEventId, 'missing_bot_token');
        return;
    }

    // 1. Flujo de vinculación: `/start <token>`
    if (/^\/start(?:\s+|$)/i.test(rawText)) {
        const startTokenArg = rawText.replace(/^\/start\s*/i, '').trim();
        if (startTokenArg.length > 0) {
            const [{ data: org }, telegramFeatureEnabled] = await Promise.all([
                fastify.supabaseAdmin
                    .from('organizations')
                    .select('status')
                    .eq('id', organizationId)
                    .maybeSingle(),
                isFeatureEnabled(organizationId, FEATURE_KEYS.TELEGRAM),
            ]);

            if (!org || org.status === 'suspended' || !telegramFeatureEnabled) {
                await sendTelegramMessage(botToken, {
                    chatId: telegramChatId,
                    text: TELEGRAM_USER_MESSAGES.LINK_INVALID,
                });
                await markWebhookProcessed(fastify, webhookEventId, 'feature_or_org_disabled');
                return;
            }

            const redeemResult = await redeemTelegramStartToken({
                organizationId,
                rawToken: startTokenArg,
                telegramUserId,
                telegramChatId,
                telegramUsername: message.from.username,
                telegramFirstName: message.from.first_name,
            });

            await recordTelegramMessage({
                organizationId,
                telegramIdentityId: redeemResult.identityId ?? null,
                direction: 'inbound',
                telegramUpdateId: update.update_id,
                telegramMessageId: message.message_id,
                harnessStatus: 'system',
                error: redeemResult.ok ? null : 'link_token_rejected',
            });

            const sendRes = await sendTelegramMessage(botToken, {
                chatId: telegramChatId,
                text: redeemResult.message,
            });

            await recordTelegramMessage({
                organizationId,
                telegramIdentityId: redeemResult.identityId ?? null,
                direction: 'outbound',
                telegramUpdateId: update.update_id,
                telegramMessageId: sendRes.ok ? sendRes.messageId : null,
                harnessStatus: 'system',
                error: sendRes.ok ? null : sendRes.message,
            });

            await markWebhookProcessed(fastify, webhookEventId);
            return;
        }
    }

    // 2. Re-verificación completa de los 6 candados de autorización en cada mensaje
    const authz = await authorizeTelegramMessageSender(organizationId, telegramUserId);
    if (!authz.ok) {
        fastify.log.warn(
            {
                organization_id: organizationId,
                telegram_update_id: update.update_id,
                telegram_chat_id: telegramChatId,
                telegram_user_id: telegramUserId,
                reason: authz.reason,
            },
            '[TelegramJob] Remitente de Telegram no autorizado'
        );

        await recordTelegramMessage({
            organizationId,
            direction: 'inbound',
            telegramUpdateId: update.update_id,
            telegramMessageId: message.message_id,
            harnessStatus: 'error',
            error: authz.reason,
        });

        await sendTelegramMessage(botToken, {
            chatId: telegramChatId,
            text: authz.userMessage,
        });

        await markWebhookProcessed(fastify, webhookEventId, authz.reason);
        return;
    }

    const identity = authz.identity;

    // Actualizar marca de última actividad de la identidad
    await fastify.supabaseAdmin
        .from('telegram_identities')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', identity.id)
        .eq('organization_id', organizationId);

    // 3. Comandos de sistema (/start sin token, /ayuda, /help, preguntas de capacidades, /nuevo, /reset)
    const lowerText = rawText.toLowerCase();
    if (isTelegramHelpQuery(rawText)) {
        const sendRes = await sendTelegramMessage(botToken, {
            chatId: telegramChatId,
            text: TELEGRAM_USER_MESSAGES.HELP,
        });
        await recordTelegramMessage({
            organizationId,
            telegramIdentityId: identity.id,
            direction: 'outbound',
            telegramUpdateId: update.update_id,
            telegramMessageId: sendRes.ok ? sendRes.messageId : null,
            harnessStatus: 'system',
        });
        await markWebhookProcessed(fastify, webhookEventId);
        return;
    }

    if (lowerText === '/nuevo' || lowerText === '/reset') {
        await clearConversationContext(organizationId, telegramChatId);
        const sendRes = await sendTelegramMessage(botToken, {
            chatId: telegramChatId,
            text: TELEGRAM_USER_MESSAGES.CONTEXT_CLEARED,
        });
        await recordTelegramMessage({
            organizationId,
            telegramIdentityId: identity.id,
            direction: 'outbound',
            telegramUpdateId: update.update_id,
            telegramMessageId: sendRes.ok ? sendRes.messageId : null,
            harnessStatus: 'system',
        });
        await markWebhookProcessed(fastify, webhookEventId);
        return;
    }

    if (!rawText) {
        await sendTelegramMessage(botToken, {
            chatId: telegramChatId,
            text: TELEGRAM_USER_MESSAGES.EMPTY_QUESTION,
        });
        await markWebhookProcessed(fastify, webhookEventId);
        return;
    }

    // 4. Cargar contexto conversacional activo (ventana de 3 turnos, TTL 30m)
    const activeConv = await getActiveConversationContext(
        organizationId,
        telegramChatId,
        identity.id
    );

    await recordTelegramMessage({
        organizationId,
        conversationId: activeConv.conversationId,
        telegramIdentityId: identity.id,
        direction: 'inbound',
        telegramUpdateId: update.update_id,
        telegramMessageId: message.message_id,
    });

    // 5. Invocar el arnés central (`askHarness`)
    const startMs = Date.now();
    try {
        const response = await askHarness(fastify, organizationId, {
            channel: 'telegram',
            actorKey: `tg:${identity.id}`,
            question: rawText,
            conversationContext: activeConv.turns,
            conversationId: activeConv.conversationId,
        });

        if (response.status === 'success') {
            await appendConversationTurn(organizationId, telegramChatId, identity.id, {
                question: rawText,
                intent: response.intent,
                parameters: { periodo: { type: response.period.type } },
                period: { type: response.period.type } as NlPeriodParam,
                resultDigest: buildResultDigest(response),
            });
        }

        const formattedHtml = formatHarnessResponseForTelegram(response);
        const chunks = splitTelegramHtmlMessage(formattedHtml);
        const sendRes = await sendTelegramHtmlChunks(botToken, telegramChatId, chunks);

        await recordTelegramMessage({
            organizationId,
            conversationId: activeConv.conversationId,
            telegramIdentityId: identity.id,
            direction: 'outbound',
            telegramUpdateId: update.update_id,
            telegramMessageId: sendRes.messageIds[0] ?? null,
            intent: response.status === 'success' ? response.intent : null,
            harnessStatus: response.status,
            executionTimeMs: Date.now() - startMs,
            error: sendRes.ok ? null : sendRes.error ?? 'send_failed',
        });

        fastify.log.info(
            {
                organization_id: organizationId,
                telegram_update_id: update.update_id,
                telegram_chat_id: telegramChatId,
                telegram_user_id: telegramUserId,
                conversation_id: activeConv.conversationId,
                harness_status: response.status,
                intent: response.status === 'success' ? response.intent : null,
                execution_time_ms: Date.now() - startMs,
            },
            '[TelegramJob] Consulta de reporte procesada y enviada por Telegram'
        );

        await markWebhookProcessed(fastify, webhookEventId);
    } catch (err: unknown) {
        const userSafeMessage =
            err instanceof NaturalReportsError
                ? err.message
                : TELEGRAM_USER_MESSAGES.EXECUTION_ERROR;
        const internalError = err instanceof Error ? err.message : String(err);

        fastify.log.error(
            {
                err,
                organization_id: organizationId,
                telegram_update_id: update.update_id,
                telegram_chat_id: telegramChatId,
                telegram_user_id: telegramUserId,
                conversation_id: activeConv.conversationId,
            },
            '[TelegramJob] Error ejecutando consulta en el arnés'
        );

        await sendTelegramMessage(botToken, {
            chatId: telegramChatId,
            text: userSafeMessage,
        });

        await recordTelegramMessage({
            organizationId,
            conversationId: activeConv.conversationId,
            telegramIdentityId: identity.id,
            direction: 'outbound',
            telegramUpdateId: update.update_id,
            harnessStatus: 'error',
            executionTimeMs: Date.now() - startMs,
            error: internalError,
        });

        await markWebhookProcessed(fastify, webhookEventId, internalError);
    }
}

export async function registerProcessTelegramUpdateWorker(fastify: FastifyInstance): Promise<void> {
    if (!fastify.pgBoss) {
        fastify.log.warn('[TelegramJob] pg-boss no está disponible; no se registró el worker de Telegram');
        return;
    }

    await fastify.pgBoss.createQueue(TELEGRAM_PROCESS_UPDATE_QUEUE);
    await fastify.pgBoss.work<ProcessTelegramUpdateJobData>(
        TELEGRAM_PROCESS_UPDATE_QUEUE,
        async (jobs) => {
            const jobList = Array.isArray(jobs) ? jobs : [jobs];
            for (const job of jobList) {
                if (job?.data) {
                    if (job.data.webhookEventId) {
                        const { data: ev } = await fastify.supabaseAdmin
                            .from('webhook_events')
                            .select('processed_at')
                            .eq('id', job.data.webhookEventId)
                            .maybeSingle();
                        if (ev?.processed_at) {
                            continue;
                        }
                    }
                    await processTelegramUpdateJob(fastify, job.data);
                }
            }
        }
    );
}
