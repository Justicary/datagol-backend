import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveWidgetOrigin, isOriginRegistered } from '../lib/widget-auth.js';
import { getOrganizationFeatures } from '../services/entitlements.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { createWidgetSession } from '../services/widget-session.js';
import { widgetSessionBodySchema, widgetSessionResponseSchema } from '../schemas/widget-session.js';

function resolveSourceIp(request: FastifyRequest): string {
    const forwarded = request.headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const firstIp = raw ? String(raw).split(',')[0].trim() : '';
    return firstIp || request.ip;
}

/**
 * Widget de chat web embebido — POST /api/widget/session.
 *
 * CORS restringido a orígenes registrados en `widget_origins`, nunca
 * comodín (AGENTS.md, tarea "chatbot web": "CORS: permitir solo los
 * orígenes registrados, jamás comodín"). El hook CORS global de `app.ts`
 * excluye explícitamente `/api/widget/**` para que el hook de abajo sea el
 * único que decide `Access-Control-Allow-Origin` en esta ruta.
 *
 * El preflight `OPTIONS` llega sin cuerpo, así que no conocemos todavía la
 * `publicKey` (va en el body del POST) — solo podemos validar que el
 * `Origin` esté registrado para ALGUNA organización (existencia, sin
 * resolver a cuál). La autorización real y completa —`publicKey` -> esa
 * organización -> ese origin exacto— ocurre en el handler `POST`
 * (`resolveWidgetOrigin`), que puede rechazar con 403 sin comprometer el
 * encabezado CORS ya otorgado: un origen legítimamente registrado pero con
 * una `publicKey` equivocada solo puede leer un 403, nunca datos de otro
 * tenant.
 */
export async function widgetRoutes(fastify: FastifyInstance) {
    fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type');

        const origin = request.headers.origin;
        if (origin && (await isOriginRegistered(fastify, origin))) {
            reply.header('Access-Control-Allow-Origin', origin);
        }

        if (request.method === 'OPTIONS') {
            return reply.status(204).send();
        }
    });

    fastify.post('/api/widget/session', async (request: FastifyRequest, reply: FastifyReply) => {
        const bodyResult = widgetSessionBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'El campo "publicKey" es obligatorio.' });
        }

        const originHeader = request.headers.origin;
        const auth = await resolveWidgetOrigin(fastify, bodyResult.data.publicKey, originHeader);
        if (!auth.ok) {
            const statusCode = auth.reason === 'missing_origin' ? 400 : auth.reason === 'suspended' ? 403 : 403;
            request.log.warn({ reason: auth.reason, route: 'widget-session', msg: 'Sesión de widget rechazada' });
            return reply
                .status(statusCode)
                .send({ error: statusCode === 400 ? 'BadRequest' : 'Forbidden', message: auth.message });
        }

        const features = await getOrganizationFeatures(auth.organizationId);
        if (!features.has(FEATURE_KEYS.WEB_WIDGET)) {
            return reply.status(403).send({
                error: 'Forbidden',
                code: 'FEATURE_DISABLED',
                message: 'El widget de chat no está habilitado para esta organización.',
                requiredFeature: FEATURE_KEYS.WEB_WIDGET,
            });
        }

        const sourceIp = resolveSourceIp(request);
        const result = await createWidgetSession(
            fastify,
            auth.organizationId,
            auth.dailySessionLimit,
            sourceIp,
            originHeader as string
        );

        return reply.status(200).send(widgetSessionResponseSchema.parse(result));
    });
}

export default widgetRoutes;
