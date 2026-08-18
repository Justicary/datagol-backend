import { FastifyInstance } from 'fastify';
import type { ReportType } from '../types/reports.js';

/**
 * Bucket dedicado, distinto de `organization-attachments`
 * (attachment-service.ts): ese bucket tiene un trigger de "un solo activo a
 * la vez" pensado para el adjunto de agradecimiento — los reportes semanales
 * necesitan conservar histórico (uno por semana), no reemplazarse entre sí.
 */
export const REPORTS_BUCKET = 'organization-reports';

const MAX_REPORT_SIZE_BYTES = 5 * 1024 * 1024; // 5MB — HTML de un reporte nunca debería acercarse a esto

/**
 * Asegura la existencia del bucket privado para reportes en Supabase Storage.
 * Mismo patrón que `ensureAttachmentBucket` (attachment-service.ts).
 */
export async function ensureReportsBucket(fastify: FastifyInstance): Promise<void> {
    try {
        const { data: buckets } = await fastify.supabaseAdmin.storage.listBuckets();
        const exists = buckets?.some((b) => b.name === REPORTS_BUCKET);
        if (!exists) {
            await fastify.supabaseAdmin.storage.createBucket(REPORTS_BUCKET, {
                public: false,
                fileSizeLimit: MAX_REPORT_SIZE_BYTES,
            });
        }
    } catch (err) {
        fastify.log.warn({ err }, '[ReportStorage] Error al verificar/crear bucket de reportes');
    }
}

export function buildReportStoragePath(organizationId: string, reportType: ReportType, weekStart: string): string {
    return `${organizationId}/${reportType}/${weekStart}.html`;
}

export interface UploadWeeklyReportResult {
    storagePath: string;
    sizeBytes: number;
}

/**
 * Sube el HTML ya renderizado del reporte (mismo HTML que se envía por
 * correo, ver email-renderer.ts) al bucket privado de reportes.
 */
export async function uploadWeeklyReportHtml(
    fastify: FastifyInstance,
    organizationId: string,
    reportType: ReportType,
    weekStart: string,
    html: string
): Promise<UploadWeeklyReportResult> {
    await ensureReportsBucket(fastify);

    const storagePath = buildReportStoragePath(organizationId, reportType, weekStart);
    const buffer = Buffer.from(html, 'utf-8');

    const { error: uploadError } = await fastify.supabaseAdmin.storage.from(REPORTS_BUCKET).upload(storagePath, buffer, {
        contentType: 'text/html; charset=utf-8',
        upsert: true,
    });

    if (uploadError) {
        fastify.log.error({ uploadError, organizationId, reportType, weekStart }, '[ReportStorage] Falló la subida a Storage');
        throw new Error(`Error al almacenar el reporte en Supabase Storage: ${uploadError.message}`);
    }

    return { storagePath, sizeBytes: buffer.length };
}

/**
 * Genera una URL firmada para descargar un reporte — mismo patrón que
 * `generateAttachmentSignedUrl` (attachment-service.ts), 24h de vigencia por
 * defecto (mismo TTL que ya usa thank-you-service.ts para adjuntos).
 */
export async function generateReportSignedUrl(
    fastify: FastifyInstance,
    storagePath: string,
    expiresInSeconds = 3600 * 24
): Promise<string | null> {
    try {
        const { data, error } = await fastify.supabaseAdmin.storage.from(REPORTS_BUCKET).createSignedUrl(storagePath, expiresInSeconds);

        if (error || !data?.signedUrl) {
            fastify.log.warn({ error, storagePath }, '[ReportStorage] Error generando signedUrl');
            return null;
        }

        return data.signedUrl;
    } catch (err) {
        fastify.log.error({ err, storagePath }, '[ReportStorage] Excepción al generar signedUrl');
        return null;
    }
}
