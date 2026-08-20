import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveToolOrganization } from '../../lib/tool-auth.js';
import { withToolTimeout, ToolTimeoutError, TOOL_READ_TIMEOUT_MS } from '../../lib/tool-timeout.js';
import { getAvailableSlots, CalCredentialsMissingError, CalProviderError } from '../../services/cal-com-tool-client.js';
import {
    toolParamsSchema,
    availabilityBodySchema,
    availabilityResponseSchema,
    isValidDateString,
} from '../../schemas/tool-routes.js';

const DEGRADED_MESSAGE = 'No puedo consultar la agenda en este momento, ¿te llamo de vuelta?';

/**
 * POST /tools/:webhookToken/availability — Fase 5.2.
 * Máximo dos opciones en la respuesta; disponibilidad cacheada por tenant con
 * TTL corto (ver cal-com-tool-client.ts). Nunca consulta contenido estático
 * del negocio: eso vive en la knowledge base nativa de ElevenLabs.
 */
export async function availabilityToolRoute(fastify: FastifyInstance) {
    fastify.post('/tools/:webhookToken/availability', async (request: FastifyRequest, reply: FastifyReply) => {
        const paramsResult = toolParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'webhookToken inválido en la ruta' });
        }

        const secretHeader = request.headers['x-tool-secret'] as string | undefined;
        const auth = await resolveToolOrganization(fastify, paramsResult.data.webhookToken, secretHeader);
        if (!auth.ok) {
            const statusCode = auth.reason === 'suspended' ? 403 : 401;
            request.log.warn({ reason: auth.reason, route: 'availability', msg: 'Tool call rechazado' });
            return reply.status(statusCode).send({
                error: statusCode === 403 ? 'Forbidden' : 'Unauthorized',
                message: auth.message,
            });
        }

        const bodyResult = availabilityBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Cuerpo de la petición inválido' });
        }
        const { startTime, endTime, timeZone } = bodyResult.data;

        if (!isValidDateString(startTime) || !isValidDateString(endTime)) {
            return reply.status(400).send({ error: 'BadRequest', message: 'startTime/endTime no son fechas válidas' });
        }

        if (!auth.calEventTypeId) {
            request.log.error({ organizationId: auth.organizationId, msg: 'Organización sin cal_event_type_id configurado' });
            return reply.status(200).send(availabilityResponseSchema.parse({
                available: false,
                slots: [],
                message: DEGRADED_MESSAGE,
            }));
        }

        try {
            const slots = await withToolTimeout(
                (signal) =>
                    getAvailableSlots(
                        fastify,
                        auth.organizationId,
                        { eventTypeId: auth.calEventTypeId!, startTime, endTime, timeZone },
                        signal
                    ),
                TOOL_READ_TIMEOUT_MS
            );

            const topSlots = slots.slice(0, 2).map((s) => s.time);
            const message =
                topSlots.length > 0
                    ? `Horarios disponibles: ${topSlots.join(' y ')}.`
                    : 'No encontré horarios disponibles en ese rango, ¿probamos con otra fecha?';

            return reply.status(200).send(
                availabilityResponseSchema.parse({
                    available: topSlots.length > 0,
                    slots: topSlots,
                    message,
                })
            );
        } catch (err) {
            logDegradedFailure(request, auth.organizationId, err);
            return reply.status(200).send(
                availabilityResponseSchema.parse({
                    available: false,
                    slots: [],
                    message: DEGRADED_MESSAGE,
                })
            );
        }
    });
}

function logDegradedFailure(request: FastifyRequest, organizationId: string, err: unknown): void {
    const errName = err instanceof Error ? err.name : 'UnknownError';
    const errMessage = err instanceof Error ? err.message : String(err);

    if (err instanceof CalCredentialsMissingError) {
        request.log.error({ organizationId, msg: 'Tool degradado: cal_api_key no configurado' });
    } else if (err instanceof ToolTimeoutError) {
        request.log.warn({ organizationId, msg: 'Tool degradado: timeout consultando Cal.com' });
    } else if (err instanceof CalProviderError) {
        request.log.warn({ organizationId, status: err.status, msg: 'Tool degradado: Cal.com respondió error' });
    } else {
        request.log.error({ organizationId, errName, errMessage, msg: 'Tool degradado: error inesperado' });
    }
}

export default availabilityToolRoute;
