import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { generateAndDeliverWeeklyReport } from '../services/weekly-report-service.js';
import type { ReportType } from '../types/reports.js';

export const GENERATE_WEEKLY_REPORT_QUEUE = 'generate-weekly-report';

export interface GenerateWeeklyReportJobData {
    organizationId: string;
    reportType: ReportType;
    weekStart: string;
}

/**
 * Worker individual por organización — la idempotencia real vive en
 * `generateAndDeliverWeeklyReport` (INSERT...ON CONFLICT sobre
 * weekly_reports), así que un reintento de pg-boss de este job es inofensivo
 * por diseño: el segundo intento simplemente no reclama el slot y termina.
 */
export async function generateWeeklyReportHandler(fastify: FastifyInstance, job: Job<GenerateWeeklyReportJobData>): Promise<void> {
    const { organizationId, reportType, weekStart } = job.data;
    await generateAndDeliverWeeklyReport(fastify, { organizationId, reportType, weekStart });
}

export async function registerGenerateWeeklyReportWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(GENERATE_WEEKLY_REPORT_QUEUE, { retryLimit: 3, retryBackoff: true });

    await fastify.pgBoss.work<GenerateWeeklyReportJobData>(GENERATE_WEEKLY_REPORT_QUEUE, async ([job]) => {
        await generateWeeklyReportHandler(fastify, job);
    });
}
