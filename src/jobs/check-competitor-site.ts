import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { checkCompetitorSite } from '../services/competitor-scraper-service.js';
import { getOrganizationFeatures } from '../services/entitlements.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';

export const CHECK_COMPETITOR_SITE_QUEUE = 'check-competitor-site';

export interface CheckCompetitorSiteJobData {
    competitorSiteId: string;
    organizationId: string;
    url: string;
    weekStart: string;
}

/**
 * Worker individual por sitio (Fase C). Idempotencia real: `UNIQUE
 * (competitor_site_id, week_start)` sobre `competitor_site_snapshots` — un
 * reintento de pg-boss que llega después de que otro run ya insertó el
 * snapshot de esta semana simplemente recibe 23505 y no duplica nada
 * (mismo patrón "hacer el trabajo, luego intentar guardar" que
 * `sendThankYouWhatsApp`; no hace falta una fila de reclamo previa como en
 * weekly-report-service.ts porque aquí solo hay un efecto, no varios pasos
 * encadenados).
 */
export async function checkCompetitorSiteHandler(fastify: FastifyInstance, job: Job<CheckCompetitorSiteJobData>): Promise<void> {
    const { competitorSiteId, organizationId, url, weekStart } = job.data;

    // Verificación de feature justo antes del efecto (AGENTS.md §16) — el
    // sweep (sweep-competitor-analysis.ts) solo filtra por "sitio sin
    // snapshot esta semana", no por feature.
    const features = await getOrganizationFeatures(organizationId);
    if (!features.has(FEATURE_KEYS.COMPETITOR_ANALYSIS)) {
        fastify.log.info({ organizationId, competitorSiteId }, '[CheckCompetitorSite] Feature no habilitada, se omite');
        return;
    }

    const result = await checkCompetitorSite(url);

    const { error: insertError } = await fastify.supabaseAdmin.from('competitor_site_snapshots').insert({
        competitor_site_id: competitorSiteId,
        organization_id: organizationId,
        week_start: weekStart,
        fetch_status: result.status,
        extracted_text: result.text ?? null,
        error: result.error ?? null,
    });

    if (insertError) {
        if (insertError.code === '23505') {
            fastify.log.info({ organizationId, competitorSiteId, weekStart }, '[CheckCompetitorSite] Ya existía un snapshot esta semana, se omite');
            return;
        }
        throw new Error(`No se pudo guardar el snapshot de competitor_site_id=${competitorSiteId}: ${insertError.message}`);
    }

    const { error: updateError } = await fastify.supabaseAdmin
        .from('competitor_sites')
        .update({
            last_checked_at: new Date().toISOString(),
            last_error: result.status === 'ok' ? null : (result.error ?? result.status),
        })
        .eq('id', competitorSiteId);

    if (updateError) {
        fastify.log.warn({ err: updateError.message, competitorSiteId }, '[CheckCompetitorSite] Snapshot guardado, pero falló actualizar last_checked_at');
    }

    fastify.log.info({ organizationId, competitorSiteId, status: result.status }, '[CheckCompetitorSite] Sitio revisado');
}

export async function registerCheckCompetitorSiteWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(CHECK_COMPETITOR_SITE_QUEUE, { retryLimit: 2, retryBackoff: true });

    await fastify.pgBoss.work<CheckCompetitorSiteJobData>(CHECK_COMPETITOR_SITE_QUEUE, async ([job]) => {
        await checkCompetitorSiteHandler(fastify, job);
    });
}
