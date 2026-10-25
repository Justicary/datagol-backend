import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { telegramWebhookParamsSchema, telegramUpdateSchema } from '../../schemas/telegram.js';
import { resolveAndAuthenticateTelegramWebhook } from '../../services/telegram/telegram-auth.js';
import { WEBHOOK_EVENT_PROVIDERS } from '../../types/webhook-provider.js';
import {
    TELEGRAM_PROCESS_UPDATE_QUEUE,
    processTelegramUpdateJob,
} from '../../jobs/process-telegram-update.js';

const WEBHOOK_PATH = '/webhooks/telegram/:webhookToken';

export async function telegramWebhookRoutes(fastify: FastifyInstance) {
    fastify.post(WEBHOOK_PATH, async (request: FastifyRequest, reply: FastifyReply) => {
        const paramsResult = telegramWebhookParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({
                error: 'BadRequest',
                message: 'webhookToken inválido en la ruta',
            });
        }

        const { webhookToken } = paramsResult.data;
        const secretHeader = request.headers['x-telegram-bot-api-secret-token'] as string | undefined;

        // 1. Doble candado: enrutamiento por webhookToken + autenticación timing-safe del secret header
        const auth = await resolveAndAuthenticateTelegramWebhook(fastify, webhookToken, secretHeader);
        if (!auth.ok) {
            request.log.warn(
                { reason: auth.reason, msg: 'Webhook de Telegram rechazado en autenticación' }
            );
            return reply.status(auth.statusCode).send({
                error: auth.statusCode === 401 ? 'Unauthorized' : 'Forbidden',
                message: auth.message,
            });
        }

        // 2. Validar el Update entrante con Zod
        const parsedUpdate = telegramUpdateSchema.safeParse(request.body);
        if (!parsedUpdate.success) {
            request.log.warn(
                { organizationId: auth.organizationId, msg: 'Webhook de Telegram rechazado: esquema Zod inválido' }
            );
            return reply.status(400).send({
                error: 'BadRequest',
                message: 'Payload de Update de Telegram inválido',
            });
        }

        const update = parsedUpdate.data;
        const eventType = update.message ? 'message' : update.edited_message ? 'edited_message' : 'other';
        const eventId = `${eventType}:${update.update_id}`;

        // 3. Idempotencia en webhook_events (UNIQUE(provider, event_id))
        const { data: insertedEvent, error: insertError } = await fastify.supabaseAdmin
            .from('webhook_events')
            .insert({
                organization_id: auth.organizationId,
                provider: WEBHOOK_EVENT_PROVIDERS.TELEGRAM,
                event_id: eventId,
                event_type: eventType,
                raw_payload: {
                    update_id: update.update_id,
                    event_type: eventType,
                    chat_id: update.message?.chat.id ?? update.edited_message?.chat.id ?? null,
                    chat_type: update.message?.chat.type ?? update.edited_message?.chat.type ?? null,
                    from_id: update.message?.from?.id ?? update.edited_message?.from?.id ?? null,
                },
            })
            .select('id')
            .single();

        if (insertError) {
            if (insertError.code === '23505') {
                request.log.info(
                    {
                        organizationId: auth.organizationId,
                        telegram_update_id: update.update_id,
                        msg: 'Update de Telegram duplicado ignorado por idempotencia',
                    }
                );
                return reply.status(200).send({ ok: true, duplicate: true });
            }

            request.log.error(
                {
                    organizationId: auth.organizationId,
                    telegram_update_id: update.update_id,
                    err: insertError.message,
                    msg: 'Error persistiendo webhook_events de Telegram',
                }
            );
            return reply.status(500).send({
                error: 'InternalServerError',
                message: 'Error al registrar evento de webhook',
            });
        }

        const webhookEventId = insertedEvent.id as string;

        // 4. Ignorar de forma segura updates que no sean mensajes en chat privado 1:1
        if (
            !update.message ||
            update.message.chat.type !== 'private' ||
            !update.message.from ||
            update.message.from.is_bot
        ) {
            await fastify.supabaseAdmin
                .from('webhook_events')
                .update({ processed_at: new Date().toISOString() })
                .eq('id', webhookEventId);

            return reply.status(200).send({ ok: true, ignored: true });
        }

        // 5. Encolar procesamiento asíncrono en pg-boss y responder 200 OK rápido
        if (!fastify.pgBoss) {
            request.log.error(
                { organizationId: auth.organizationId, telegram_update_id: update.update_id },
                'pg-boss no disponible para encolar update de Telegram'
            );
            return reply.status(503).send({
                error: 'ServiceUnavailable',
                message: 'Cola de trabajos no disponible',
            });
        }

        const jobData = {
            organizationId: auth.organizationId,
            webhookEventId,
            update,
        };

        // 1. Ejecutar PRIMERO dentro del ciclo HTTP activo para que Cloud Run en
        //    Modo Desarrollo (--min-instances=0 --cpu-throttling) mantenga el 100%
        //    de CPU asignada y marque `webhook_events.processed_at` ANTES de encolar
        //    en pg-boss (evitando la condición de carrera donde pg-boss y la ruta
        //    ejecutan el job en paralelo y envían la respuesta por duplicado).
        try {
            await processTelegramUpdateJob(fastify, jobData);
        } catch (err) {
            request.log.error(
                { err, organizationId: auth.organizationId, telegram_update_id: update.update_id },
                'Error inesperado en ejecución en línea de Telegram; pg-boss actuará como respaldo'
            );
        }

        // 2. Encolar en pg-boss como registro durable y respaldo (si `processed_at`
        //    ya fue marcado en el paso 1, el worker de pg-boss lo omite de inmediato).
        await fastify.pgBoss.send(
            TELEGRAM_PROCESS_UPDATE_QUEUE,
            jobData,
            {
                singletonKey: `${auth.organizationId}:${eventId}`,
                retryLimit: 2,
                retryDelay: 5,
            }
        );

        request.log.info({
            organizationId: auth.organizationId,
            telegram_update_id: update.update_id,
            telegram_chat_id: update.message.chat.id,
            telegram_user_id: update.message.from.id,
            msg: 'Update de Telegram procesado y registrado exitosamente',
        });

        return reply.status(200).send({ ok: true });
    });
}

export default telegramWebhookRoutes;
