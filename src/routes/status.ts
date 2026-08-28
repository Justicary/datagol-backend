import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { checkAndRecordHit } from '../lib/rate-limiter.js';

const paramsSchema = z.object({
    statusToken: z.string().trim().min(16).max(128),
});

const IP_LIMIT = 30;
const IP_WINDOW_MS = 10 * 60 * 1000;
const TOKEN_LIMIT = 20;
const TOKEN_WINDOW_MS = 60 * 1000;

/**
 * Fase E — GET /status/:statusToken. Pública, sin sesión: resuelve un
 * despliegue únicamente por su `status_token` opaco y rotable
 * (`deployments.status_token`, `55_control_plane_datagol.sql`). Fuera del
 * prefijo `/control/**` a propósito — es la página que visita el cliente
 * final, no un administrador — pero solo existe en api.datagol.net porque
 * las tablas que consulta son exclusivas del plano de control (ver
 * src/app.ts).
 *
 * Requisitos de seguridad (Fase E): nunca expone datos fiscales, montos ni
 * notas internas; un token inválido responde 404 sin distinguir "no existe"
 * de "existe pero algo más falló" — revelar esa diferencia ya es una fuga.
 */
export const statusRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('onSend', async (_request, reply, payload) => {
        reply.header('Cache-Control', 'no-store');
        return payload;
    });

    fastify.get<{ Params: { statusToken: string } }>('/status/:statusToken', async (request, reply) => {
        const parseResult = paramsSchema.safeParse(request.params);
        if (!parseResult.success) {
            return reply.status(404).send({ error: 'NotFound', message: 'No se encontró información de estatus para este enlace.' });
        }
        const { statusToken } = parseResult.data;

        const ipCheck = checkAndRecordHit(`status-ip:${request.ip}`, IP_LIMIT, IP_WINDOW_MS);
        const tokenCheck = checkAndRecordHit(`status-token:${statusToken}`, TOKEN_LIMIT, TOKEN_WINDOW_MS);
        if (!ipCheck.ok || !tokenCheck.ok) {
            return reply.status(429).send({ error: 'TooManyRequests', message: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' });
        }

        const { data: deployment, error: deploymentError } = await fastify.supabaseAdmin
            .from('deployments')
            .select('id, status, customers(trade_name)')
            .eq('status_token', statusToken)
            .maybeSingle();

        // Mismo mensaje genérico para "no existe" y para "el token es válido
        // pero algo más salió mal" — distinguirlos filtraría existencia.
        if (deploymentError || !deployment) {
            return reply.status(404).send({ error: 'NotFound', message: 'No se encontró información de estatus para este enlace.' });
        }

        const { data: progress } = await fastify.supabaseAdmin
            .from('v_provisioning_progress')
            .select('total, completadas, bloqueadas, pendientes_criticas, pendientes_del_cliente, porcentaje')
            .eq('deployment_id', deployment.id)
            .maybeSingle();

        const { data: tasks } = await fastify.supabaseAdmin
            .from('provisioning_tasks')
            .select('task_key, label, description, owner, status, is_blocking, blocked_reason, sort_order')
            .eq('deployment_id', deployment.id)
            .order('sort_order', { ascending: true });

        const customersRelation = deployment.customers as unknown as { trade_name: string | null } | { trade_name: string | null }[] | null;
        const tradeName = (Array.isArray(customersRelation) ? customersRelation[0] : customersRelation)?.trade_name ?? 'tu instalación';

        return reply.status(200).send({
            data: {
                tradeName,
                status: deployment.status,
                progress: progress ?? { total: 0, completadas: 0, bloqueadas: 0, pendientes_criticas: 0, pendientes_del_cliente: 0, porcentaje: 0 },
                tasks: tasks ?? [],
            },
        });
    });
};

export default statusRoutes;
