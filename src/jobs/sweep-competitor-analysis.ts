import { FastifyInstance } from 'fastify';
import { CHECK_COMPETITOR_SITE_QUEUE } from './check-competitor-site.js';

export const SWEEP_COMPETITOR_ANALYSIS_QUEUE = 'sweep-competitor-analysis';

/** Lunes 00:00 UTC de la semana que contiene `now` (misma convención de `week_start` que weekly_reports/competitor_site_snapshots). */
function currentIsoWeekStart(now = new Date()): string {
    const dow = now.getUTCDay(); // 0=domingo..6=sábado
    const offsetFromMonday = (dow + 6) % 7;
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offsetFromMonday));
    return monday.toISOString().slice(0, 10);
}

/**
 * Sweep semanal (C.2 — "un acceso por sitio por semana"), cron fijo, sin
 * depender de la zona horaria de cada organización (a diferencia del
 * scheduler de reportes, B.1 — aquí no hay una hora local que respetar,
 * solo una cadencia semanal). Encola un chequeo individual por cada sitio
 * habilitado que todavía no tiene snapshot esta semana ISO. NO filtra por
 * feature habilitada aquí — eso lo hace `check-competitor-site.ts` justo
 * antes de scrapear (AGENTS.md §16), mismo criterio que
 * `sweep-weekly-reports.ts`.
 */
export async function sweepCompetitorAnalysisHandler(fastify: FastifyInstance): Promise<void> {
    const weekStart = currentIsoWeekStart();

    const { data: sites, error: sitesError } = await fastify.supabaseAdmin
        .from('competitor_sites')
        .select('id, organization_id, url')
        .eq('enabled', true);

    if (sitesError) {
        throw new Error(`No se pudo listar competitor_sites: ${sitesError.message}`);
    }

    const { data: existingSnapshots, error: snapshotsError } = await fastify.supabaseAdmin
        .from('competitor_site_snapshots')
        .select('competitor_site_id')
        .eq('week_start', weekStart);

    if (snapshotsError) {
        throw new Error(`No se pudo listar competitor_site_snapshots de la semana: ${snapshotsError.message}`);
    }

    const alreadyChecked = new Set((existingSnapshots ?? []).map((s) => s.competitor_site_id as string));

    let enqueued = 0;
    for (const site of sites ?? []) {
        if (alreadyChecked.has(site.id)) continue;

        await fastify.pgBoss.send(CHECK_COMPETITOR_SITE_QUEUE, {
            competitorSiteId: site.id,
            organizationId: site.organization_id,
            url: site.url,
            weekStart,
        });
        enqueued += 1;
    }

    fastify.log.info({ enqueued, weekStart, totalEnabled: sites?.length ?? 0 }, '[SweepCompetitorAnalysis] Revisiones de competencia encoladas');
}

export async function registerSweepCompetitorAnalysisWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(SWEEP_COMPETITOR_ANALYSIS_QUEUE, { retryLimit: 3, retryBackoff: true });

    await fastify.pgBoss.work(SWEEP_COMPETITOR_ANALYSIS_QUEUE, async () => {
        await sweepCompetitorAnalysisHandler(fastify);
    });

    await fastify.pgBoss.schedule(SWEEP_COMPETITOR_ANALYSIS_QUEUE, '0 3 * * 1', null, { tz: 'UTC' });
}
