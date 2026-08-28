import { FastifyInstance, FastifyRequest } from 'fastify';
import { availabilityToolRoute } from './availability.js';
import { bookingToolRoute } from './booking.js';
import { rescheduleToolRoute } from './reschedule.js';
import { cancelToolRoute } from './cancel.js';
import { locationsToolRoute } from './locations.js';
import { appointmentToolRoute } from './appointment.js';
import { emailToolRoute } from './email.js';
import { productsToolRoute } from './products.js';
import { waitlistToolRoute } from './waitlist.js';
import { recordToolDuration } from '../../lib/tool-latency-tracker.js';

/**
 * Registro de `routes/tools/**` (Fase 5). Encapsulado en su propio contexto
 * de Fastify para que el hook de latencia de abajo aplique solo a estas
 * rutas: son las únicas del sistema con presupuesto contractual de latencia
 * (AGENTS.md §3 — p95 < 300 ms, p99 < 600 ms). Una regresión aquí es un bug
 * de severidad alta, no una optimización pendiente.
 */
export async function toolRoutes(fastify: FastifyInstance) {
    fastify.addHook('onRequest', async (request: FastifyRequest) => {
        (request as FastifyRequest & { toolStartedAt?: bigint }).toolStartedAt = process.hrtime.bigint();
    });

    fastify.addHook('onResponse', async (request, reply) => {
        const started = (request as FastifyRequest & { toolStartedAt?: bigint }).toolStartedAt;
        const durationMs = started ? Number(process.hrtime.bigint() - started) / 1_000_000 : undefined;
        if (durationMs !== undefined) {
            recordToolDuration(durationMs);
        }
        request.log.info({
            route: request.routeOptions?.url ?? request.url,
            statusCode: reply.statusCode,
            durationMs,
            msg: 'tool call completado',
        });
    });

    await fastify.register(availabilityToolRoute);
    await fastify.register(bookingToolRoute);
    await fastify.register(rescheduleToolRoute);
    await fastify.register(cancelToolRoute);
    await fastify.register(locationsToolRoute);
    await fastify.register(appointmentToolRoute);
    await fastify.register(emailToolRoute);
    // Precio y disponibilidad de catálogo (docs/tasks/catalogo-productos-grupos-cred.md FASE D)
    await fastify.register(productsToolRoute);
    // Lista de espera (docs/tasks/waitlist_confirmacion_masiva.md, Tarea B2)
    await fastify.register(waitlistToolRoute);
}

export default toolRoutes;
