import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuthenticatedUser } from '../lib/organization-auth.js';
import { getPermissionsForUser } from '../services/permission-service.js';
import { PERMISSION_KEYS } from '../types/permission-keys.js';
import { prepareTemplateBatch } from '../services/email/send-template-email.service.js';
import { sendTemplateEmailParamsSchema, sendTemplateEmailBodySchema, sendTemplateEmailResponseSchema } from '../schemas/send-template-email.js';

function forbiddenPermission(reply: FastifyReply, key: string) {
    return reply.status(403).send({
        success: false,
        error: 'Forbidden',
        code: 'PERMISSION_DENIED',
        message: `No tiene el permiso "${key}" en esta organización, o no pertenece a ella.`,
        requiredPermission: key,
    });
}

/**
 * POST /api/organizations/:orgId/email/send-template
 * Despacho de correo con plantilla personalizada a contactos
 * (docs/tasks/send-template-email-backend.md). Mismo patrón de autorización
 * que `contacts-crm.ts` (`authorizeContactWrite`): `edit_contacts` es el
 * permiso de "gestión de CRM" del catálogo RBAC — enviar correo a contactos
 * es una acción de escritura sobre el CRM, no una acción administrativa de
 * plataforma. Sin bypass de `platform_admin`: lo invoca el dashboard normal
 * del cliente (`SendBatchEmailModal.tsx`), no la consola de superadmin.
 */
export async function sendTemplateEmailRoutes(fastify: FastifyInstance) {
    async function authorize(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<{ userId: string; jwt: string; organizationId: string } | null> {
        const paramsResult = sendTemplateEmailParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({ success: false, error: 'El parámetro de ruta "orgId" debe ser un UUID válido.' });
            return null;
        }
        const { orgId: organizationId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const permissions = await getPermissionsForUser(organizationId, auth.userId, auth.jwt);
        if (!permissions.has(PERMISSION_KEYS.EDIT_CONTACTS)) {
            forbiddenPermission(reply, PERMISSION_KEYS.EDIT_CONTACTS);
            return null;
        }

        return { userId: auth.userId, jwt: auth.jwt, organizationId };
    }

    fastify.post('/api/organizations/:orgId/email/send-template', async (request, reply) => {
        const ctx = await authorize(request, reply);
        if (!ctx) return;

        const bodyResult = sendTemplateEmailBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            const firstIssue = bodyResult.error.issues[0];
            return reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: firstIssue?.message || 'Cuerpo de la petición inválido.',
                details: bodyResult.error.issues,
            });
        }

        const result = await prepareTemplateBatch(fastify, ctx.organizationId, bodyResult.data);
        if (!result.success) {
            return reply.status(result.statusCode).send({ success: false, error: result.error });
        }

        return reply.status(200).send(
            sendTemplateEmailResponseSchema.parse({
                success: true,
                data: result.summary,
            })
        );
    });
}

export default sendTemplateEmailRoutes;
