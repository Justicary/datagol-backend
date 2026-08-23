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

function extractAgentId(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const data = (body as Record<string, unknown>).data;
    if (!data || typeof data !== 'object') return null;
    const agentId = (data as Record<string, unknown>).agent_id;
    return typeof agentId === 'string' && agentId.trim() !== '' ? agentId : null;
}

/**
 * Ruta de webhook de post-llamada de ElevenLabs (Fase 2.1; extendida en
 * docs/tasks/catalogo-productos-grupos-cred.md FASE B.3 para workspace
 * compartido).
 *
 * La URL es específica por instalación: `/webhooks/elevenlabs/:webhookToken`.
 * `webhookToken` resuelve el tenant (o el GRUPO, si el workspace es
 * compartido) ANTES de tocar el cuerpo de la petición — no depende de ningún
 * campo del payload, que un tercero podría falsificar. Es un identificador
 * de enrutamiento, no el secreto: la autenticación real ocurre después, con
 * la firma HMAC verificada contra `webhook_signing_secret`
 * (organization_secrets/Vault, de la organización DUEÑA del grupo).
 *
 * Resolución en dos caminos, según dónde matchee `webhookToken` primero:
 *
 * A. `credential_groups.webhook_token` (workspace COMPARTIDO, FASE B.3): el
 *    token identifica al GRUPO, no a una organización. Tras verificar la
 *    firma con el secreto único del grupo, y SOLO ENTONCES, se lee `agent_id`
 *    del cuerpo y se resuelve la organización por el índice único
 *    `organizations.elevenlabs_agent_id` — rechazando si esa organización no
 *    pertenece al grupo ya autenticado.
 * B. `organizations.webhook_token` (instalación de un solo inquilino, camino
 *    histórico sin cambios — Fase 2.1 original): el token ya identifica la
 *    organización directamente, sin necesidad de `agent_id`.
 *
 * Orden de operaciones, no negociable en ambos caminos:
 * 1. Resolver el grupo o la organización por `webhookToken` de la ruta.
 * 2. Verificar la firma antes de procesar el cuerpo.
 * 3. (Solo camino A) Leer `agent_id` del cuerpo y resolver+validar la organización.
 * 4. Insertar en `webhook_events` con (provider, event_id) — un reintento no reprocesa.
 * 5. Encolar el trabajo en pg-boss.
 * 6. Responder 2xx de inmediato.
 *
 * Requisito de onboarding: sin `webhook_token` (de organización o de grupo)
 * ni `webhook_signing_secret` dados de alta, todo webhook a esta ruta se
 * rechaza con 401.
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

        // 1. Resolver PRIMERO por grupo (workspace compartido, camino A). Si
        // no matchea ningún grupo, cae al camino B histórico por organización.
        const { data: group, error: groupError } = await fastify.supabaseAdmin
            .from('credential_groups')
            .select('id, owner_organization_id')
            .eq('webhook_token', webhookToken)
            .maybeSingle();

        let signingSecretOwnerId: string;
        let resolvedGroupId: string | null = null;
        let singleTenantOrg: { id: string; status: string } | null = null;

        if (!groupError && group && group.owner_organization_id) {
            signingSecretOwnerId = group.owner_organization_id as string;
            resolvedGroupId = group.id as string;
        } else {
            const { data: org, error: orgError } = await fastify.supabaseAdmin
                .from('organizations')
                .select('id, status')
                .eq('webhook_token', webhookToken)
                .maybeSingle();

            if (orgError || !org) {
                request.log.warn({ msg: 'Webhook de ElevenLabs rechazado: webhookToken no resuelve a ningún grupo ni organización' });
                return reply.status(401).send({ error: 'Unauthorized', message: 'Token de webhook inválido' });
            }

            signingSecretOwnerId = org.id as string;
            singleTenantOrg = { id: org.id as string, status: org.status as string };
        }

        // 2. Solo ahora se recupera el secreto de firma y se verifica.
        // getSecret ya resuelve internamente contra la organización dueña del
        // grupo (Fase B.1), así que pasar signingSecretOwnerId es correcto en
        // ambos caminos aunque en el camino A ya sea directamente el owner.
        const signingSecret = await getSecret(signingSecretOwnerId, SECRET_KEYS.WEBHOOK_SIGNING_SECRET);
        const verification = verifyElevenLabsSignature(rawBody, signatureHeader, signingSecret);

        if (!verification.valid) {
            request.log.warn({
                signingSecretOwnerId,
                reason: verification.reason,
                msg: 'Webhook de ElevenLabs rechazado: firma inválida',
            });
            return reply.status(401).send({ error: 'Unauthorized', message: 'Firma de webhook inválida' });
        }

        // 3. SOLO ahora (firma ya verificada) se lee agent_id del cuerpo, y
        // solo en el camino A (grupo): en el camino B la organización ya se
        // resolvió sin depender de ningún campo del payload.
        let organizationId: string;
        let orgStatus: string;

        if (resolvedGroupId) {
            const agentId = extractAgentId(body);
            if (!agentId) {
                request.log.warn({ groupId: resolvedGroupId, msg: 'Webhook de ElevenLabs (workspace compartido) rechazado: el cuerpo no trae agent_id' });
                return reply.status(401).send({ error: 'Unauthorized', message: 'No se pudo identificar la organización del grupo' });
            }

            const { data: matchedOrg, error: matchError } = await fastify.supabaseAdmin
                .from('organizations')
                .select('id, status, credential_group_id')
                .eq('elevenlabs_agent_id', agentId)
                .maybeSingle();

            if (matchError || !matchedOrg || matchedOrg.credential_group_id !== resolvedGroupId) {
                request.log.warn({
                    groupId: resolvedGroupId,
                    agentId,
                    msg: 'Webhook de ElevenLabs (workspace compartido) rechazado: agent_id no pertenece a ninguna organización de este grupo',
                });
                return reply.status(401).send({ error: 'Unauthorized', message: 'agent_id no pertenece a este grupo' });
            }

            organizationId = matchedOrg.id as string;
            orgStatus = matchedOrg.status as string;
        } else {
            organizationId = singleTenantOrg!.id;
            orgStatus = singleTenantOrg!.status;
        }

        // Verificado DESPUÉS de la firma (nunca antes, mismo motivo que en
        // tool-auth): una organización suspendida no debe generar ni
        // call_logs ni usage_events nuevos.
        if (orgStatus === 'suspended') {
            request.log.warn({ organizationId, msg: 'Webhook de ElevenLabs rechazado: organización suspendida' });
            return reply.status(403).send({ error: 'Forbidden', message: 'Esta organización tiene su implementación suspendida.' });
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
