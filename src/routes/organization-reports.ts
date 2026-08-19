import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuthenticatedUser, requireOrganizationMembership, requireOrganizationRole } from '../lib/organization-auth.js';
import { getPermissionsForUser } from '../services/permission-service.js';
import { PERMISSION_KEYS } from '../types/permission-keys.js';
import { organizationIdParamsSchema } from '../schemas/organization-onboarding.js';
import {
    reportsListQuerySchema,
    reportsConfigResponseSchema,
    organizationReportsUpdateSchema,
    reportIdParamSchema,
} from '../schemas/reports.js';
import type { OrganizationReportsSettings, ReportScheduleSettings } from '../types/reports.js';
import { generateReportSignedUrl } from '../services/report-storage-service.js';
import { getReportsSettings as readReportsSettings } from '../services/report-settings-service.js';

/**
 * Rutas de reportes semanales (docs/tasks/reportes-semanales.md, Fase B):
 * listado, descarga (Storage), y configuración de día/hora/canales por
 * organización.
 */
export async function organizationReportsRoutes(fastify: FastifyInstance) {
    async function authorizeMember(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<{ userId: string; jwt: string; organizationId: string } | null> {
        const paramsResult = organizationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
            return null;
        }

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const isMember = await requireOrganizationMembership(fastify, auth.jwt, paramsResult.data.id);
        if (!isMember) {
            reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
            return null;
        }

        return { userId: auth.userId, jwt: auth.jwt, organizationId: paramsResult.data.id };
    }

    async function authorizeAdmin(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<{ userId: string; jwt: string; organizationId: string } | null> {
        const ctx = await authorizeMember(request, reply);
        if (!ctx) return null;

        const isAuthorizedRole = await requireOrganizationRole(fastify, ctx.jwt, ctx.organizationId, ctx.userId, ['owner', 'admin']);
        if (!isAuthorizedRole) {
            reply.status(403).send({ success: false, error: 'Se requiere rol admin u owner para configurar los reportes semanales.' });
            return null;
        }

        return ctx;
    }

    /**
     * RBAC B.5 (docs/tasks/RBAC-permisos.md): `use_nl_reports` — /reports/ask
     * consume la llave de IA de la organización, distinto de la membresía
     * simple que basta para listar los reportes semanales ya generados.
     */
    async function authorizeNlReports(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<{ userId: string; jwt: string; organizationId: string } | null> {
        const paramsResult = organizationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
            return null;
        }

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const permissions = await getPermissionsForUser(paramsResult.data.id, auth.userId, auth.jwt);
        if (!permissions.has(PERMISSION_KEYS.USE_NL_REPORTS)) {
            reply.status(403).send({
                success: false,
                error: 'Forbidden',
                code: 'PERMISSION_DENIED',
                message: `No tiene el permiso "${PERMISSION_KEYS.USE_NL_REPORTS}" en esta organización, o no pertenece a ella.`,
                requiredPermission: PERMISSION_KEYS.USE_NL_REPORTS,
            });
            return null;
        }

        return { userId: auth.userId, jwt: auth.jwt, organizationId: paramsResult.data.id };
    }

    /**
     * GET /api/organizations/:id/reports
     */
    fastify.get('/api/organizations/:id/reports', async (request, reply) => {
        const ctx = await authorizeMember(request, reply);
        if (!ctx) return;

        const queryResult = reportsListQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ success: false, error: 'Parámetros de consulta inválidos.' });
        }
        const { reportType, limit } = queryResult.data;

        let query = fastify.supabaseAdmin
            .from('weekly_reports')
            .select('id, report_type, week_start, status, generated_at, storage_path')
            .eq('organization_id', ctx.organizationId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (reportType) {
            query = query.eq('report_type', reportType);
        }

        const { data, error } = await query;
        if (error) {
            request.log.error({ organizationId: ctx.organizationId, err: error.message, msg: 'Error listando weekly_reports' });
            return reply.status(500).send({ success: false, error: 'No se pudieron listar los reportes.' });
        }

        return reply.status(200).send({
            success: true,
            data: (data ?? []).map((r) => ({
                id: r.id,
                reportType: r.report_type,
                weekStart: r.week_start,
                status: r.status,
                generatedAt: r.generated_at,
                hasDownload: Boolean(r.storage_path),
            })),
        });
    });

    /**
     * GET /api/organizations/:id/reports/:reportId/download
     * Redirige (302) a una URL firmada de 24h — nunca expone el bucket ni el
     * storage_path crudo al cliente.
     */
    fastify.get('/api/organizations/:id/reports/:reportId/download', async (request, reply) => {
        const ctx = await authorizeMember(request, reply);
        if (!ctx) return;

        const paramsResult = reportIdParamSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro "reportId" debe ser un UUID válido.' });
        }

        const { data: report, error } = await fastify.supabaseAdmin
            .from('weekly_reports')
            .select('storage_path')
            .eq('id', paramsResult.data.reportId)
            .eq('organization_id', ctx.organizationId)
            .maybeSingle();

        if (error || !report || !report.storage_path) {
            return reply.status(404).send({ success: false, error: 'Reporte no encontrado o sin archivo descargable.' });
        }

        const signedUrl = await generateReportSignedUrl(fastify, report.storage_path);
        if (!signedUrl) {
            return reply.status(500).send({ success: false, error: 'No se pudo generar el enlace de descarga.' });
        }

        return reply.redirect(signedUrl, 302);
    });

    /**
     * GET /api/organizations/:id/reports-config
     */
    fastify.get('/api/organizations/:id/reports-config', async (request, reply) => {
        const ctx = await authorizeMember(request, reply);
        if (!ctx) return;

        const settings = await readReportsSettings(fastify, ctx.organizationId);
        return reply.status(200).send(reportsConfigResponseSchema.parse({ success: true, data: settings }));
    });

    /**
     * PATCH /api/organizations/:id/reports-config
     * Solo owner/admin: cambia horarios/canales de entrega, con costo
     * potencial (WhatsApp) — mismo nivel de restricción que
     * organization-thank-you.ts.
     */
    fastify.patch('/api/organizations/:id/reports-config', async (request, reply) => {
        const ctx = await authorizeAdmin(request, reply);
        if (!ctx) return;

        const bodyResult = organizationReportsUpdateSchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido.' });
        }
        const body = bodyResult.data;

        const { data: org } = await fastify.supabaseAdmin
            .from('organizations')
            .select('integration_settings')
            .eq('id', ctx.organizationId)
            .maybeSingle();

        const currentSettings = (org?.integration_settings as Record<string, unknown>) ?? {};
        const currentReports = await readReportsSettings(fastify, ctx.organizationId);

        const updatedReports: OrganizationReportsSettings = {
            planning: body.planning ? ({ ...currentReports.planning, ...body.planning } as ReportScheduleSettings) : currentReports.planning,
            executive: body.executive ? ({ ...currentReports.executive, ...body.executive } as ReportScheduleSettings) : currentReports.executive,
            whatsappTemplateName: body.whatsappTemplateName !== undefined ? body.whatsappTemplateName : currentReports.whatsappTemplateName,
            whatsappRecipientPhone:
                body.whatsappRecipientPhone !== undefined ? body.whatsappRecipientPhone : currentReports.whatsappRecipientPhone,
        };

        const { error } = await fastify.supabaseAdmin
            .from('organizations')
            .update({
                integration_settings: { ...currentSettings, reports: updatedReports },
                updated_at: new Date().toISOString(),
            })
            .eq('id', ctx.organizationId);

        if (error) {
            request.log.error({ organizationId: ctx.organizationId, err: error.message, msg: 'Error guardando reports-config' });
            return reply.status(500).send({ success: false, error: 'No se pudo guardar la configuración de reportes.' });
        }

        return reply.status(200).send(reportsConfigResponseSchema.parse({ success: true, data: updatedReports }));
    });

    /**
     * POST /api/organizations/:id/reports/ask
     * Consulta de reportes en lenguaje natural (docs/tasks/reportes-lenguaje-natural.md)
     */
    fastify.post('/api/organizations/:id/reports/ask', async (request, reply) => {
        const ctx = await authorizeNlReports(request, reply);
        if (!ctx) return;

        const { askReportBodySchema } = await import('../schemas/natural-reports.js');
        const bodyResult = askReportBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            const firstError = bodyResult.error.issues[0]?.message || 'Cuerpo de petición inválido.';
            return reply.status(400).send({ success: false, error: firstError });
        }

        const { askReport, NaturalReportsError } = await import('../services/reports/nl-reports-service.js');
        try {
            const response = await askReport(fastify, ctx.organizationId, {
                question: bodyResult.data.question,
                userId: ctx.userId,
            });
            return reply.status(200).send(response);
        } catch (err: unknown) {
            if (err instanceof NaturalReportsError) {
                return reply.status(err.statusCode).send({ success: false, error: err.message });
            }
            request.log.error({ err, organizationId: ctx.organizationId }, '[OrganizationReports:ask] Error inesperado');
            return reply.status(500).send({
                success: false,
                error: 'Ocurrió un error inesperado al procesar la consulta en lenguaje natural.',
            });
        }
    });

    /**
     * GET /api/organizations/:id/reports/unanswered-questions
     * Consulta la bitácora de preguntas no resueltas de la organización.
     */
    fastify.get('/api/organizations/:id/reports/unanswered-questions', async (request, reply) => {
        const ctx = await authorizeAdmin(request, reply);
        if (!ctx) return;

        const { unansweredQuestionsQuerySchema } = await import('../schemas/natural-reports.js');
        const queryResult = unansweredQuestionsQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ success: false, error: 'Parámetros de consulta inválidos.' });
        }

        const { listUnansweredQuestions } = await import('../services/reports/unanswered-questions-service.js');
        try {
            const data = await listUnansweredQuestions(fastify, {
                organizationId: ctx.organizationId,
                reason: queryResult.data.reason,
                limit: queryResult.data.limit,
            });
            return reply.status(200).send({ success: true, data });
        } catch (err: unknown) {
            request.log.error({ err, organizationId: ctx.organizationId }, '[OrganizationReports:unanswered] Error listando preguntas');
            return reply.status(500).send({ success: false, error: 'No se pudieron listar las preguntas no resueltas.' });
        }
    });
}

export default organizationReportsRoutes;

