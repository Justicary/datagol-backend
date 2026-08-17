import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
    requireAuthenticatedUser,
    requireOrganizationMembership,
    requireOrganizationRole,
} from '../lib/organization-auth.js';
import {
    orgIdParamSchema,
    orgAttachmentParamSchema,
} from '../schemas/thank-you.js';
import {
    uploadOrganizationAttachment,
    listOrganizationAttachments,
    archiveOrganizationAttachment,
} from '../services/attachment-service.js';

/**
 * Rutas para la gestión de adjuntos de organización (subida, listado y archivado).
 */
export async function organizationAttachmentsRoutes(fastify: FastifyInstance) {
    async function authorizeAdmin(
        request: FastifyRequest<{ Params: { id: string } }>,
        reply: FastifyReply
    ): Promise<{ userId: string; jwt: string; organizationId: string } | null> {
        const paramsResult = orgIdParamSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
            return null;
        }
        const { id: organizationId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const isMember = await requireOrganizationMembership(fastify, auth.jwt, organizationId);
        if (!isMember) {
            reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
            return null;
        }

        const isAuthorizedRole = await requireOrganizationRole(fastify, auth.jwt, organizationId, auth.userId, ['owner', 'admin']);
        if (!isAuthorizedRole) {
            reply.status(403).send({ success: false, error: 'Se requiere rol admin u owner para gestionar adjuntos.' });
            return null;
        }

        return { userId: auth.userId, jwt: auth.jwt, organizationId };
    }

    async function authorizeMember(
        request: FastifyRequest<{ Params: { id: string } }>,
        reply: FastifyReply
    ): Promise<{ userId: string; jwt: string; organizationId: string } | null> {
        const paramsResult = orgIdParamSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
            return null;
        }
        const { id: organizationId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const isMember = await requireOrganizationMembership(fastify, auth.jwt, organizationId);
        if (!isMember) {
            reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
            return null;
        }

        return { userId: auth.userId, jwt: auth.jwt, organizationId };
    }

    /**
     * POST /api/organizations/:id/attachments
     * Sube un documento (PDF, DOCX, XLSX) mediante multipart/form-data.
     */
    fastify.post('/api/organizations/:id/attachments', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const ctx = await authorizeAdmin(request, reply);
        if (!ctx) return;

        let fileData;
        try {
            fileData = await request.file();
        } catch (err: any) {
            return reply.status(400).send({ success: false, error: `Error al leer archivo: ${err.message}` });
        }

        if (!fileData) {
            return reply.status(400).send({ success: false, error: 'No se incluyó ningún archivo en la petición.' });
        }

        let buffer: Buffer;
        try {
            buffer = await fileData.toBuffer();
        } catch {
            return reply.status(400).send({ success: false, error: 'Error al procesar el buffer del archivo.' });
        }

        if (!buffer || buffer.length === 0) {
            return reply.status(400).send({ success: false, error: 'El archivo subido está vacío.' });
        }

        try {
            const record = await uploadOrganizationAttachment(fastify, {
                organizationId: ctx.organizationId,
                fileName: fileData.filename || 'adjunto.pdf',
                fileBuffer: buffer,
                userId: ctx.userId,
            });

            request.log.info({ attachmentId: record.id, organizationId: ctx.organizationId }, 'Adjunto de organización subido y activado');

            return reply.status(201).send({
                success: true,
                message: 'Adjunto subido y activado correctamente.',
                data: record,
            });
        } catch (err: any) {
            request.log.warn({ err: err.message, organizationId: ctx.organizationId }, 'Rechazo al subir adjunto');
            return reply.status(400).send({
                success: false,
                error: err.message || 'No se pudo guardar el archivo adjunto.',
            });
        }
    });

    /**
     * GET /api/organizations/:id/attachments
     * Lista los adjuntos de la organización.
     */
    fastify.get('/api/organizations/:id/attachments', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const ctx = await authorizeMember(request, reply);
        if (!ctx) return;

        const attachments = await listOrganizationAttachments(fastify, ctx.organizationId);

        return reply.send({
            success: true,
            data: attachments,
        });
    });

    /**
     * DELETE /api/organizations/:id/attachments/:attId
     * Archiva (soft delete) un adjunto y lo desactiva.
     */
    fastify.delete('/api/organizations/:id/attachments/:attId', async (request: FastifyRequest<{ Params: { id: string; attId: string } }>, reply) => {
        const paramsResult = orgAttachmentParamSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'Los parámetros de ruta "id" y "attId" deben ser UUID válidos.',
            });
        }
        const { id: organizationId, attId: attachmentId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;

        const isMember = await requireOrganizationMembership(fastify, auth.jwt, organizationId);
        if (!isMember) {
            return reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
        }

        const isAuthorizedRole = await requireOrganizationRole(fastify, auth.jwt, organizationId, auth.userId, ['owner', 'admin']);
        if (!isAuthorizedRole) {
            return reply.status(403).send({ success: false, error: 'Se requiere rol admin u owner para archivar adjuntos.' });
        }

        const success = await archiveOrganizationAttachment(fastify, organizationId, attachmentId);
        if (!success) {
            return reply.status(500).send({ success: false, error: 'No se pudo archivar el adjunto.' });
        }

        request.log.info({ organizationId, attachmentId }, 'Adjunto archivado correctamente');

        return reply.send({
            success: true,
            message: 'Adjunto archivado correctamente.',
        });
    });
}

export default organizationAttachmentsRoutes;
