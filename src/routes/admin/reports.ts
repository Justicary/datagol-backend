import { FastifyPluginAsync } from 'fastify';
import { isPlatformAdmin } from '../../lib/platform-admin.js';
import { unansweredQuestionsQuerySchema } from '../../schemas/natural-reports.js';
import {
    listUnansweredQuestions,
    getUnansweredQuestionsSummary,
} from '../../services/reports/unanswered-questions-service.js';

/**
 * Rutas administrativas de la plataforma para la supervisión y evolución
 * de reportes en lenguaje natural (docs/tasks/reportes-lenguaje-natural.md, Fase F).
 */
export const adminReportsRoutes: FastifyPluginAsync = async (fastify) => {
    // Proteger todas las rutas en este plugin con isPlatformAdmin
    fastify.addHook('preHandler', isPlatformAdmin);

    /**
     * GET /api/admin/reports/unanswered-questions
     * Listado transversal de preguntas no resueltas en todas las organizaciones.
     */
    fastify.get('/api/admin/reports/unanswered-questions', async (request, reply) => {
        const queryResult = unansweredQuestionsQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({
                statusCode: 400,
                error: 'BadRequest',
                message: 'Parámetros de consulta inválidos.',
            });
        }

        try {
            const data = await listUnansweredQuestions(fastify, {
                organizationId: queryResult.data.organizationId,
                reason: queryResult.data.reason,
                limit: queryResult.data.limit,
            });

            return reply.status(200).send({
                success: true,
                data,
            });
        } catch (err: unknown) {
            request.log.error({ err }, '[AdminReports] Error listando preguntas');
            return reply.status(500).send({
                statusCode: 500,
                error: 'InternalServerError',
                message: 'Error al consultar preguntas no resueltas.',
            });
        }
    });

    /**
     * GET /api/admin/reports/unanswered-questions/summary
     * Resumen agregado de preguntas frecuentes no resueltas para guiar el catálogo v2.
     */
    fastify.get('/api/admin/reports/unanswered-questions/summary', async (request, reply) => {
        try {
            const summary = await getUnansweredQuestionsSummary(fastify);
            return reply.status(200).send({
                success: true,
                data: summary,
            });
        } catch (err: unknown) {
            request.log.error({ err }, '[AdminReports] Error obteniendo resumen');
            return reply.status(500).send({
                statusCode: 500,
                error: 'InternalServerError',
                message: 'Error al obtener resumen de preguntas no resueltas.',
            });
        }
    });
};

export default adminReportsRoutes;
