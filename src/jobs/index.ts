import { FastifyInstance } from 'fastify';
import { registerProcessCallCompletedWorker } from './process-call-completed.js';
import { registerProcessVapiCallCompletedWorker } from './process-vapi-call-completed.js';
import { registerNotifyHotLeadWorker } from './notify-hot-lead.js';
import { registerSendCallSummaryWorker } from './send-call-summary.js';
import { registerSendProspectSummaryWorker } from './send-prospect-summary.js';

/**
 * Registra todos los workers de pg-boss de la aplicación. Se invoca una vez
 * al arrancar, después de que el plugin de pg-boss esté listo.
 */
export async function registerJobs(fastify: FastifyInstance): Promise<void> {
    await registerProcessCallCompletedWorker(fastify);
    await registerProcessVapiCallCompletedWorker(fastify);
    await registerNotifyHotLeadWorker(fastify);
    await registerSendCallSummaryWorker(fastify);
    await registerSendProspectSummaryWorker(fastify);
}
