import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveToolOrganization } from '../../lib/tool-auth.js';
import { withToolTimeout, TOOL_READ_TIMEOUT_MS, TOOL_MUTATION_TIMEOUT_MS, ToolTimeoutError } from '../../lib/tool-timeout.js';
import { searchInbox, getMessageDetail, ImapConnectionError } from '../../services/email/imap-client.js';
import { getAccountCredentials } from '../../services/email/email-account-vault.js';
import { getActiveEmailAccount } from '../../services/email/email-account.service.js';
import { dispatchOrSaveDraft } from '../../services/email/email-dispatch.service.js';
import {
    toolParamsSchema,
    isValidDateString,
    emailSearchBodySchema,
    emailSearchResponseSchema,
    emailReadBodySchema,
    emailReadResponseSchema,
    emailDispatchBodySchema,
    emailDispatchResponseSchema,
} from '../../schemas/tool-routes.js';

const DEGRADED_SEARCH_MESSAGE = 'No puedo consultar el correo en este momento, ¿deseas que te contacte por otro medio?';
const DEGRADED_READ_MESSAGE = 'No puedo abrir ese correo en este momento, ¿deseas que te contacte por otro medio?';
const DEGRADED_DISPATCH_MESSAGE = 'No puedo enviar el correo en este momento, ¿deseas que te contacte por otro medio?';

/**
 * POST /tools/:webhookToken/email/{search,read,dispatch} — Integración de
 * correo nativa (docs/tasks/native-mail-integration.md §3). Calcado del
 * patrón de routes/tools/booking.ts: tenant resuelto por webhookToken
 * (nunca body), timeout duro por operación, siempre HTTP 200 con un mensaje
 * verbalizable en el camino degradado.
 */
export async function emailToolRoute(fastify: FastifyInstance) {
    fastify.post('/tools/:webhookToken/email/search', async (request: FastifyRequest, reply: FastifyReply) => {
        const paramsResult = toolParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'webhookToken inválido en la ruta' });
        }

        const secretHeader = request.headers['x-tool-secret'] as string | undefined;
        const auth = await resolveToolOrganization(fastify, paramsResult.data.webhookToken, secretHeader);
        if (!auth.ok) {
            const statusCode = auth.reason === 'suspended' ? 403 : 401;
            return reply.status(statusCode).send({ error: statusCode === 403 ? 'Forbidden' : 'Unauthorized', message: auth.message });
        }

        const bodyResult = emailSearchBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Cuerpo de la petición inválido' });
        }
        const { subject, from, since, before, limit } = bodyResult.data;

        if (since && !isValidDateString(since)) {
            return reply.status(400).send({ error: 'BadRequest', message: 'El campo "since" no es una fecha válida' });
        }
        if (before && !isValidDateString(before)) {
            return reply.status(400).send({ error: 'BadRequest', message: 'El campo "before" no es una fecha válida' });
        }

        const accountResult = await getActiveEmailAccount(fastify, auth.organizationId, bodyResult.data.emailAccountId);
        if (!accountResult.ok) {
            return reply.status(200).send(emailSearchResponseSchema.parse({ found: false, message: accountResult.message, messages: [] }));
        }
        const { account } = accountResult;

        const credentials = await getAccountCredentials(account.vault_secret_id);
        if (!credentials) {
            request.log.error({ organizationId: auth.organizationId, msg: 'Tool degradado: no se pudieron recuperar credenciales IMAP' });
            return reply.status(200).send(emailSearchResponseSchema.parse({ found: false, message: DEGRADED_SEARCH_MESSAGE, messages: [] }));
        }

        try {
            const results = await withToolTimeout(
                () =>
                    searchInbox(
                        { host: account.imap_host, port: account.imap_port, secure: account.imap_secure, user: account.imap_username, pass: credentials.imapPassword },
                        {
                            subject,
                            from,
                            since: since ? new Date(since) : undefined,
                            before: before ? new Date(before) : undefined,
                            limit,
                        }
                    ),
                TOOL_READ_TIMEOUT_MS
            );

            return reply.status(200).send(
                emailSearchResponseSchema.parse({
                    found: results.length > 0,
                    message: results.length > 0 ? `Encontré ${results.length} correo(s).` : 'No encontré correos que coincidan con esa búsqueda.',
                    messages: results,
                })
            );
        } catch (err) {
            logDegradedFailure(request, auth.organizationId, 'search', err);
            return reply.status(200).send(emailSearchResponseSchema.parse({ found: false, message: DEGRADED_SEARCH_MESSAGE, messages: [] }));
        }
    });

    fastify.post('/tools/:webhookToken/email/read', async (request: FastifyRequest, reply: FastifyReply) => {
        const paramsResult = toolParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'webhookToken inválido en la ruta' });
        }

        const secretHeader = request.headers['x-tool-secret'] as string | undefined;
        const auth = await resolveToolOrganization(fastify, paramsResult.data.webhookToken, secretHeader);
        if (!auth.ok) {
            const statusCode = auth.reason === 'suspended' ? 403 : 401;
            return reply.status(statusCode).send({ error: statusCode === 403 ? 'Forbidden' : 'Unauthorized', message: auth.message });
        }

        const bodyResult = emailReadBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Cuerpo de la petición inválido' });
        }

        const uid = Number(bodyResult.data.uid);
        if (!Number.isInteger(uid) || uid <= 0) {
            return reply.status(400).send({ error: 'BadRequest', message: 'El campo "uid" debe ser un entero positivo' });
        }

        const accountResult = await getActiveEmailAccount(fastify, auth.organizationId, bodyResult.data.emailAccountId);
        if (!accountResult.ok) {
            return reply.status(200).send(emailReadResponseSchema.parse({ found: false, message: accountResult.message, email: null }));
        }
        const { account } = accountResult;

        const credentials = await getAccountCredentials(account.vault_secret_id);
        if (!credentials) {
            request.log.error({ organizationId: auth.organizationId, msg: 'Tool degradado: no se pudieron recuperar credenciales IMAP' });
            return reply.status(200).send(emailReadResponseSchema.parse({ found: false, message: DEGRADED_READ_MESSAGE, email: null }));
        }

        try {
            const detail = await withToolTimeout(
                () =>
                    getMessageDetail(
                        { host: account.imap_host, port: account.imap_port, secure: account.imap_secure, user: account.imap_username, pass: credentials.imapPassword },
                        uid
                    ),
                TOOL_READ_TIMEOUT_MS
            );

            if (!detail) {
                return reply.status(200).send(emailReadResponseSchema.parse({ found: false, message: 'No encontré ese correo.', email: null }));
            }

            return reply.status(200).send(emailReadResponseSchema.parse({ found: true, message: 'Correo encontrado.', email: detail }));
        } catch (err) {
            logDegradedFailure(request, auth.organizationId, 'read', err);
            return reply.status(200).send(emailReadResponseSchema.parse({ found: false, message: DEGRADED_READ_MESSAGE, email: null }));
        }
    });

    fastify.post('/tools/:webhookToken/email/dispatch', async (request: FastifyRequest, reply: FastifyReply) => {
        const paramsResult = toolParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'webhookToken inválido en la ruta' });
        }

        const secretHeader = request.headers['x-tool-secret'] as string | undefined;
        const auth = await resolveToolOrganization(fastify, paramsResult.data.webhookToken, secretHeader);
        if (!auth.ok) {
            const statusCode = auth.reason === 'suspended' ? 403 : 401;
            return reply.status(statusCode).send({ error: statusCode === 403 ? 'Forbidden' : 'Unauthorized', message: auth.message });
        }

        const bodyResult = emailDispatchBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Cuerpo de la petición inválido' });
        }
        const body = bodyResult.data;

        const accountResult = await getActiveEmailAccount(fastify, auth.organizationId, body.emailAccountId);
        if (!accountResult.ok) {
            return reply.status(200).send(emailDispatchResponseSchema.parse({ dispatched: false, message: accountResult.message, status: null }));
        }
        const { account } = accountResult;

        try {
            const result = await withToolTimeout(
                () =>
                    dispatchOrSaveDraft(auth.organizationId, account.id, {
                        idempotencyKey: body.idempotencyKey,
                        toAddresses: body.toAddresses,
                        ccAddresses: body.ccAddresses,
                        subject: body.subject,
                        bodyText: body.bodyText,
                        bodyHtml: body.bodyHtml ?? null,
                        contactId: body.contactId ?? null,
                        isDraft: body.isDraft,
                    }),
                TOOL_MUTATION_TIMEOUT_MS
            );

            if (!result.success) {
                return reply.status(200).send(emailDispatchResponseSchema.parse({ dispatched: false, message: result.error, status: null }));
            }

            return reply.status(200).send(emailDispatchResponseSchema.parse({ dispatched: true, message: result.message, status: result.status }));
        } catch (err) {
            logDegradedFailure(request, auth.organizationId, 'dispatch', err);
            return reply.status(200).send(emailDispatchResponseSchema.parse({ dispatched: false, message: DEGRADED_DISPATCH_MESSAGE, status: null }));
        }
    });
}

function logDegradedFailure(request: FastifyRequest, organizationId: string, op: string, err: unknown): void {
    const errName = err instanceof Error ? err.name : 'UnknownError';
    const errMessage = err instanceof Error ? err.message : String(err);

    if (err instanceof ToolTimeoutError) {
        request.log.warn({ organizationId, op, msg: 'Tool degradado: timeout en operación de correo' });
    } else if (err instanceof ImapConnectionError) {
        request.log.warn({ organizationId, op, errMessage, msg: 'Tool degradado: error de conexión IMAP' });
    } else {
        request.log.error({ organizationId, op, errName, errMessage, msg: 'Tool degradado: error inesperado' });
    }
}

export default emailToolRoute;
