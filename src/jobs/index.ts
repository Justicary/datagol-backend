import { FastifyInstance } from 'fastify';
import { registerProcessCallCompletedWorker } from './process-call-completed.js';
import { registerProcessVapiCallCompletedWorker } from './process-vapi-call-completed.js';
import { registerNotifyHotLeadWorker } from './notify-hot-lead.js';
import { registerSendCallSummaryWorker } from './send-call-summary.js';
import { registerSendProspectSummaryWorker } from './send-prospect-summary.js';
import { registerCheckElevenLabsCreditsWorker } from './check-elevenlabs-credits.js';
import { registerSendThankYouWorker } from './send-thank-you.js';
import { registerGenerateWeeklyReportWorker } from './generate-weekly-report.js';
import { registerSweepWeeklyReportsWorker } from './sweep-weekly-reports.js';
import { registerCheckCompetitorSiteWorker } from './check-competitor-site.js';
import { registerSweepCompetitorAnalysisWorker } from './sweep-competitor-analysis.js';
import { registerReconcileCalBookingsWorker } from './reconcile-cal-bookings.js';
import { registerNotifyPendingOutcomesWorker } from './notify-pending-outcomes.js';

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
    await registerCheckElevenLabsCreditsWorker(fastify);
    await registerSendThankYouWorker(fastify);
    await registerGenerateWeeklyReportWorker(fastify);
    await registerSweepWeeklyReportsWorker(fastify);
    await registerCheckCompetitorSiteWorker(fastify);
    await registerSweepCompetitorAnalysisWorker(fastify);
    await registerReconcileCalBookingsWorker(fastify);
    await registerNotifyPendingOutcomesWorker(fastify);
}
