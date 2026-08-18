import { FastifyInstance } from 'fastify';
import { REPORT_TYPES } from '../types/reports.js';
import { GENERATE_WEEKLY_REPORT_QUEUE } from './generate-weekly-report.js';

export const SWEEP_WEEKLY_REPORTS_QUEUE = 'sweep-weekly-reports';

/** Debe coincidir con el cron de `registerSweepWeeklyReportsWorker` (abajo) —
 * se pasa explícito a la función SQL en vez de confiar en su propio default,
 * para que ambos nunca puedan divergir en silencio. */
const SWEEP_INTERVAL_SQL = '6 hours';

interface DueOrganization {
    organization_id: string;
    week_start: string;
}

/**
 * Sweep (B.1, docs/tasks/reportes-semanales.md): corre cada 6 horas, llama a
 * `organizations_due_for_report` (db/migrations/36_weekly_reports.sql) una
 * vez por tipo de reporte, y encola un job individual por organización
 * elegible — mismo patrón "sweep + worker individual" que
 * `check-elevenlabs-credits.ts`, para que el fallo de una organización no
 * bloquee a las demás. No filtra por feature habilitada aquí: eso lo hace
 * `generateAndDeliverWeeklyReport` justo antes de generar (AGENTS.md §16).
 */
export async function sweepWeeklyReportsHandler(fastify: FastifyInstance): Promise<void> {
    let totalEnqueued = 0;

    for (const reportType of Object.values(REPORT_TYPES)) {
        const { data, error } = await fastify.supabaseAdmin.rpc('organizations_due_for_report', {
            p_report_type: reportType,
            p_sweep_interval: SWEEP_INTERVAL_SQL,
        });

        if (error) {
            fastify.log.error({ err: error.message, reportType }, '[SweepWeeklyReports] organizations_due_for_report falló');
            continue;
        }

        const due = (data ?? []) as DueOrganization[];
        for (const row of due) {
            await fastify.pgBoss.send(GENERATE_WEEKLY_REPORT_QUEUE, {
                organizationId: row.organization_id,
                reportType,
                weekStart: row.week_start,
            });
            totalEnqueued += 1;
        }
    }

    fastify.log.info({ totalEnqueued }, '[SweepWeeklyReports] Reportes semanales encolados');
}

export async function registerSweepWeeklyReportsWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(SWEEP_WEEKLY_REPORTS_QUEUE, { retryLimit: 3, retryBackoff: true });

    await fastify.pgBoss.work(SWEEP_WEEKLY_REPORTS_QUEUE, async () => {
        await sweepWeeklyReportsHandler(fastify);
    });

    await fastify.pgBoss.schedule(SWEEP_WEEKLY_REPORTS_QUEUE, '0 */6 * * *', null, { tz: 'UTC' });
}
