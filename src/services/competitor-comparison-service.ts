import { FastifyInstance } from 'fastify';
import { COMPETITOR_FETCH_STATUSES, type CompetitorAnalysisReportData, type CompetitorSiteAnalysis } from '../types/competitor-analysis.js';

export interface SnapshotComparison {
    isBaseline: boolean;
    addedLines: string[];
    removedLines: string[];
}

function normalizeLines(text: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const key = line.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            result.push(line);
        }
    }
    return result;
}

/**
 * Compara dos instantáneas de texto por diferencia de conjuntos de líneas
 * normalizadas (trim + minúsculas para comparar, texto original para
 * mostrar). Deliberadamente simple — no es un diff tipo Git, no detecta
 * líneas "movidas" ni reordenadas, solo qué apareció y qué desapareció.
 * `previousText === null` → primera semana, sin comparación posible (C.3).
 */
export function compareSnapshots(previousText: string | null, currentText: string): SnapshotComparison {
    const currentLines = normalizeLines(currentText);

    if (previousText === null) {
        return { isBaseline: true, addedLines: [], removedLines: [] };
    }

    const previousLines = normalizeLines(previousText);
    const previousSet = new Set(previousLines.map((l) => l.toLowerCase()));
    const currentSet = new Set(currentLines.map((l) => l.toLowerCase()));

    return {
        isBaseline: false,
        addedLines: currentLines.filter((l) => !previousSet.has(l.toLowerCase())),
        removedLines: previousLines.filter((l) => !currentSet.has(l.toLowerCase())),
    };
}

function shiftDate(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/**
 * Arma los datos de análisis de competencia para el reporte ejecutivo de una
 * semana dada. Lee snapshots YA calculados por
 * src/jobs/check-competitor-site.ts — nunca dispara un fetch en vivo, para
 * no acoplar la generación del reporte a 3 llamadas HTTP externas.
 *
 * Un sitio sin snapshot para `weekStart` (el sweep semanal aún no corrió, o
 * el sitio se agregó después) se omite en vez de inventar un resultado.
 * Devuelve `null` si no hay ningún sitio habilitado o ninguno tiene datos
 * esta semana — el llamador simplemente no agrega la sección.
 */
export async function getCompetitorAnalysisForReport(
    fastify: FastifyInstance,
    organizationId: string,
    weekStart: string
): Promise<CompetitorAnalysisReportData | null> {
    const { data: sites, error: sitesError } = await fastify.supabaseAdmin
        .from('competitor_sites')
        .select('id, url, label')
        .eq('organization_id', organizationId)
        .eq('enabled', true);

    if (sitesError || !sites || sites.length === 0) {
        return null;
    }

    const previousWeekStart = shiftDate(weekStart, -7);
    const results: CompetitorSiteAnalysis[] = [];

    for (const site of sites) {
        const { data: currentSnapshot } = await fastify.supabaseAdmin
            .from('competitor_site_snapshots')
            .select('fetch_status, extracted_text, error')
            .eq('competitor_site_id', site.id)
            .eq('week_start', weekStart)
            .maybeSingle();

        if (!currentSnapshot) continue;

        if (currentSnapshot.fetch_status !== COMPETITOR_FETCH_STATUSES.OK) {
            results.push({
                siteId: site.id,
                label: site.label,
                url: site.url,
                status: currentSnapshot.fetch_status,
                error: currentSnapshot.error,
                isBaseline: false,
                addedLines: [],
                removedLines: [],
            });
            continue;
        }

        const { data: previousSnapshot } = await fastify.supabaseAdmin
            .from('competitor_site_snapshots')
            .select('extracted_text, fetch_status')
            .eq('competitor_site_id', site.id)
            .eq('week_start', previousWeekStart)
            .maybeSingle();

        const previousText =
            previousSnapshot?.fetch_status === COMPETITOR_FETCH_STATUSES.OK ? (previousSnapshot.extracted_text ?? '') : null;
        const comparison = compareSnapshots(previousText, currentSnapshot.extracted_text ?? '');

        results.push({
            siteId: site.id,
            label: site.label,
            url: site.url,
            status: currentSnapshot.fetch_status,
            isBaseline: comparison.isBaseline,
            addedLines: comparison.addedLines,
            removedLines: comparison.removedLines,
        });
    }

    if (results.length === 0) {
        return null;
    }

    return { approximate: true, sites: results };
}
