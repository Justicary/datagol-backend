import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getSecret } from '../../services/secret-service.js';
import { verifyElevenLabsSignature } from '../../services/webhook-verification.js';
import { PROCESS_CALL_COMPLETED_QUEUE } from '../../jobs/process-call-completed.js';
import { SECRET_KEYS } from '../../types/secret-keys.js';
import { WEBHOOK_EVENT_PROVIDERS } from '../../types/webhook-provider.js';

const WEBHOOK_PATH = '/webhooks/elevenlabs/:webhookToken';

const paramsSchema = z.object({
    webhookToken: z.string().min(1),
});

function extractEventType(body: unknown): string {
    if (!body || typeof body !== 'object') return 'unknown';
    const type = (body as Record<string, unknown>).type;
    return typeof type === 'string' && type.trim() !== '' ? type : 'unknown';
}

function extractConversationId(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const data = (body as Record<string, unknown>).data;
    if (!data || typeof data !== 'object') return null;
    const conversationId = (data as Record<string, unknown>).conversation_id;
    return typeof conversationId === 'string' && conversationId.trim() !== '' ? conversationId : null;
}

/**
 * Ruta de webhook de post-llamada de ElevenLabs (Fase 2.1).
 *
 * La URL es específica por organización: `/webhooks/elevenlabs/:webhookToken`.
 * `webhookToken` (columna `organizations.webhook_token`) resuelve el tenant
 * ANTES de tocar el cuerpo de la petición — no depende de ningún campo del
 * payload, que un tercero podría falsificar. Es un identificador de
 * enrutamiento, no el secreto: la autenticación real ocurre después, con la
 * firma HMAC verificada contra `webhook_signing_secret` (organization_secrets/Vault).
 *
 * Orden de operaciones, no negociable (ver docs/tasks/backend-implementation.md §2.1):
 * 1. Resolver la organización por `webhookToken` de la ruta.
 * 2. Verificar la firma antes de procesar el cuerpo.
 * 3. Insertar en `webhook_events` con (provider, event_id) — un reintento no reprocesa.
 * 4. Encolar el trabajo en pg-boss.
 * 5. Responder 2xx de inmediato.
 *
 * Requisito de onboarding: sin `webhook_token` ni `webhook_signing_secret`
 * dados de alta para la organización (ver scripts/provision-org-secrets.ts),
 * todo webhook a esta ruta se rechaza con 401.
 */
export async function elevenLabsPostCallWebhookRoutes(fastify: FastifyInstance) {
    fastify.post(WEBHOOK_PATH, async (request: FastifyRequest, reply: FastifyReply) => {
        const paramsResult = paramsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'webhookToken inválido en la ruta' });
        }
        const { webhookToken } = paramsResult.data;

        const rawBody = request.rawBody ?? '';
        const signatureHeader = request.headers['elevenlabs-signature'] as string | undefined;
        const body = request.body;

        // 1. Resolver la organización por el token de la ruta, antes de leer el cuerpo.
        const { data: org, error: orgError } = await fastify.supabaseAdmin
            .from('organizations')
            .select('id')
            .eq('webhook_token', webhookToken)
            .maybeSingle();

        if (orgError || !org) {
            request.log.warn({ msg: 'Webhook de ElevenLabs rechazado: webhookToken no resuelve a ninguna organización' });
            return reply.status(401).send({ error: 'Unauthorized', message: 'Token de webhook inválido' });
        }

        const organizationId = org.id as string;

        // 2. Solo ahora se recupera el secreto de firma y se verifica.
        const signingSecret = await getSecret(organizationId, SECRET_KEYS.WEBHOOK_SIGNING_SECRET);
        const verification = verifyElevenLabsSignature(rawBody, signatureHeader, signingSecret);

        if (!verification.valid) {
            request.log.warn({
                organizationId,
                reason: verification.reason,
                msg: 'Webhook de ElevenLabs rechazado: firma inválida',
            });
            return reply.status(401).send({ error: 'Unauthorized', message: 'Firma de webhook inválida' });
        }

        const eventType = extractEventType(body);
        const conversationId = extractConversationId(body);
        if (!conversationId) {
            request.log.warn({ organizationId, msg: 'Webhook de ElevenLabs firmado correctamente pero sin conversation_id' });
            return reply.status(200).send({ status: 'ignored' });
        }

        // event_id incluye el tipo de evento: ElevenLabs puede enviar más de un
        // tipo de webhook (post_call_transcription, post_call_audio, ...) para
        // la misma conversación, y no deben chocar entre sí en la restricción única.
        const eventId = `${eventType}:${conversationId}`;

        const { data: insertedEvent, error: insertError } = await fastify.supabaseAdmin
            .from('webhook_events')
            .insert({
                organization_id: organizationId,
                provider: WEBHOOK_EVENT_PROVIDERS.ELEVENLABS,
                event_id: eventId,
                event_type: eventType,
                raw_payload: body,
            })
            .select('id')
            .single();

        if (insertError) {
            if (insertError.code === '23505') {
                // Restricción única violada: es un reintento de entrega. No se reprocesa.
                request.log.info({ organizationId, eventId, msg: 'Webhook de ElevenLabs reintentado, ya procesado' });
                return reply.status(200).send({ status: 'duplicate' });
            }
            request.log.error({ organizationId, eventId, err: insertError.message, msg: 'Error al registrar webhook_events' });
            return reply.status(500).send({ error: 'InternalServerError', message: 'No se pudo registrar el evento' });
        }

        try {
            await fastify.pgBoss.send(PROCESS_CALL_COMPLETED_QUEUE, { webhookEventId: insertedEvent.id });
        } catch (queueError: any) {
            request.log.error({
                organizationId,
                eventId,
                webhookEventId: insertedEvent.id,
                err: queueError.message,
                msg: 'Error al encolar process-call-completed',
            });
            return reply.status(500).send({ error: 'InternalServerError', message: 'No se pudo encolar el procesamiento' });
        }

        return reply.status(200).send({ status: 'accepted' });
    });
}

export default elevenLabsPostCallWebhookRoutes;
