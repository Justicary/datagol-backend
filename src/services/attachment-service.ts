import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { validateAttachmentMagicBytes, MAX_ATTACHMENT_SIZE_BYTES } from '../lib/magic-bytes.js';
import type { OrganizationAttachmentRecord } from '../types/thank-you.js';

export const ATTACHMENTS_BUCKET = 'organization-attachments';

export interface UploadAttachmentParams {
    organizationId: string;
    fileName: string;
    fileBuffer: Buffer;
    userId?: string | null;
}

/**
 * Asegura la existencia del bucket privado para adjuntos en Supabase Storage.
 */
export async function ensureAttachmentBucket(fastify: FastifyInstance): Promise<void> {
    try {
        const { data: buckets } = await fastify.supabaseAdmin.storage.listBuckets();
        const exists = buckets?.some((b) => b.name === ATTACHMENTS_BUCKET);
        if (!exists) {
            await fastify.supabaseAdmin.storage.createBucket(ATTACHMENTS_BUCKET, {
                public: false,
                fileSizeLimit: MAX_ATTACHMENT_SIZE_BYTES,
            });
        }
    } catch (err) {
        fastify.log.warn({ err }, '[AttachmentService] Error al verificar/crear bucket de adjuntos');
    }
}

/**
 * Sube y activa un archivo adjunto para una organización tras validar sus magic bytes.
 */
export async function uploadOrganizationAttachment(
    fastify: FastifyInstance,
    params: UploadAttachmentParams
): Promise<OrganizationAttachmentRecord> {
    const { organizationId, fileName, fileBuffer, userId } = params;

    const validated = validateAttachmentMagicBytes(fileBuffer);
    if (!validated) {
        throw new Error('El archivo no es un documento válido. Solo se admiten archivos PDF, DOCX y XLSX de hasta 10 MB.');
    }

    await ensureAttachmentBucket(fastify);

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${organizationId}/${randomUUID()}-${safeName}`;

    // 1. Cargar archivo al bucket privado de Supabase Storage
    const { error: uploadError } = await fastify.supabaseAdmin.storage
        .from(ATTACHMENTS_BUCKET)
        .upload(storagePath, fileBuffer, {
            contentType: validated.mimeType,
            upsert: true,
        });

    if (uploadError) {
        fastify.log.error({ uploadError, organizationId }, '[AttachmentService] Falló la subida a Storage');
        throw new Error(`Error al almacenar el archivo en Supabase Storage: ${uploadError.message}`);
    }

    // 2. Insertar registro en organization_attachments (el trigger desactiva otros activos)
    const { data: record, error: dbError } = await fastify.supabaseAdmin
        .from('organization_attachments')
        .insert({
            organization_id: organizationId,
            file_name: fileName,
            mime_type: validated.mimeType,
            size_bytes: fileBuffer.length,
            storage_path: storagePath,
            is_active: true,
            uploaded_by: userId ?? null,
        })
        .select()
        .single<OrganizationAttachmentRecord>();

    if (dbError || !record) {
        fastify.log.error({ dbError, organizationId }, '[AttachmentService] Falló el insert en organization_attachments');
        throw new Error(`Error al registrar el adjunto en base de datos: ${dbError?.message ?? 'sin datos'}`);
    }

    // 3. Sincronizar con integration_settings.thankYou.attachmentId
    try {
        const { data: org } = await fastify.supabaseAdmin
            .from('organizations')
            .select('integration_settings')
            .eq('id', organizationId)
            .maybeSingle();

        const settings = (org?.integration_settings as Record<string, any>) || {};
        const currentThankYou = settings.thankYou || {};

        const updatedSettings = {
            ...settings,
            thankYou: {
                ...currentThankYou,
                attachmentId: record.id,
            },
        };

        await fastify.supabaseAdmin
            .from('organizations')
            .update({ integration_settings: updatedSettings })
            .eq('id', organizationId);
    } catch (syncErr) {
        fastify.log.warn({ syncErr, organizationId }, '[AttachmentService] No se pudo sincronizar thankYou.attachmentId en integration_settings');
    }

    return record;
}

/**
 * Obtiene el adjunto activo y vigente de una organización.
 */
export async function getActiveOrganizationAttachment(
    fastify: FastifyInstance,
    organizationId: string
): Promise<OrganizationAttachmentRecord | null> {
    const { data, error } = await fastify.supabaseAdmin
        .from('organization_attachments')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('is_active', true)
        .is('archived_at', null)
        .maybeSingle<OrganizationAttachmentRecord>();

    if (error || !data) {
        return null;
    }

    return data;
}

/**
 * Obtiene un adjunto específico por ID perteneciente a una organización.
 */
export async function getOrganizationAttachmentById(
    fastify: FastifyInstance,
    organizationId: string,
    attachmentId: string
): Promise<OrganizationAttachmentRecord | null> {
    const { data, error } = await fastify.supabaseAdmin
        .from('organization_attachments')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('id', attachmentId)
        .is('archived_at', null)
        .maybeSingle<OrganizationAttachmentRecord>();

    if (error || !data) {
        return null;
    }

    return data;
}

/**
 * Lista todos los adjuntos no archivados de una organización.
 */
export async function listOrganizationAttachments(
    fastify: FastifyInstance,
    organizationId: string
): Promise<OrganizationAttachmentRecord[]> {
    const { data, error } = await fastify.supabaseAdmin
        .from('organization_attachments')
        .select('*')
        .eq('organization_id', organizationId)
        .is('archived_at', null)
        .order('created_at', { ascending: false });

    if (error || !data) {
        return [];
    }

    return data as OrganizationAttachmentRecord[];
}

/**
 * Genera una URL firmada de descarga temporal para un adjunto.
 */
export async function generateAttachmentSignedUrl(
    fastify: FastifyInstance,
    storagePath: string,
    expiresInSeconds = 3600
): Promise<string | null> {
    try {
        const { data, error } = await fastify.supabaseAdmin.storage
            .from(ATTACHMENTS_BUCKET)
            .createSignedUrl(storagePath, expiresInSeconds);

        if (error || !data?.signedUrl) {
            fastify.log.warn({ error, storagePath }, '[AttachmentService] Error generando signedUrl');
            return null;
        }

        return data.signedUrl;
    } catch (err) {
        fastify.log.error({ err, storagePath }, '[AttachmentService] Excepción al generar signedUrl');
        return null;
    }
}

/**
 * Descarga el contenido binario de un adjunto desde Supabase Storage.
 */
export async function downloadAttachmentBuffer(
    fastify: FastifyInstance,
    storagePath: string
): Promise<Buffer | null> {
    try {
        const { data, error } = await fastify.supabaseAdmin.storage
            .from(ATTACHMENTS_BUCKET)
            .download(storagePath);

        if (error || !data) {
            fastify.log.warn({ error, storagePath }, '[AttachmentService] Error al descargar adjunto');
            return null;
        }

        const arrayBuffer = await data.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (err) {
        fastify.log.error({ err, storagePath }, '[AttachmentService] Excepción al descargar buffer de adjunto');
        return null;
    }
}

/**
 * Archiva (soft delete) un adjunto y lo desactiva.
 */
export async function archiveOrganizationAttachment(
    fastify: FastifyInstance,
    organizationId: string,
    attachmentId: string
): Promise<boolean> {
    const { error } = await fastify.supabaseAdmin
        .from('organization_attachments')
        .update({
            is_active: false,
            archived_at: new Date().toISOString(),
        })
        .eq('organization_id', organizationId)
        .eq('id', attachmentId);

    if (error) {
        fastify.log.error({ error, organizationId, attachmentId }, '[AttachmentService] Error al archivar adjunto');
        return false;
    }

    // Limpiar attachmentId en integration_settings si apuntaba a este archivo
    try {
        const { data: org } = await fastify.supabaseAdmin
            .from('organizations')
            .select('integration_settings')
            .eq('id', organizationId)
            .maybeSingle();

        const settings = (org?.integration_settings as Record<string, any>) || {};
        if (settings.thankYou?.attachmentId === attachmentId) {
            settings.thankYou.attachmentId = null;
            await fastify.supabaseAdmin
                .from('organizations')
                .update({ integration_settings: settings })
                .eq('id', organizationId);
        }
    } catch (cleanErr) {
        fastify.log.warn({ cleanErr, organizationId }, '[AttachmentService] No se pudo limpiar thankYou.attachmentId');
    }

    return true;
}
