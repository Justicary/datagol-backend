/**
-- =============================================================================
-- Tipos y constantes canónicas para el Análisis de Competencia
-- (docs/tasks/reportes-semanales.md, Fase C)
-- =============================================================================
*/

export const COMPETITOR_FETCH_STATUSES = {
    OK: 'ok',
    BLOCKED_BY_ROBOTS: 'blocked_by_robots',
    HTTP_ERROR: 'http_error',
    TIMEOUT: 'timeout',
    NETWORK_ERROR: 'network_error',
} as const;

export type CompetitorFetchStatus = (typeof COMPETITOR_FETCH_STATUSES)[keyof typeof COMPETITOR_FETCH_STATUSES];

export const ALL_COMPETITOR_FETCH_STATUSES: readonly CompetitorFetchStatus[] = Object.values(COMPETITOR_FETCH_STATUSES);

export function isCompetitorFetchStatus(value: string): value is CompetitorFetchStatus {
    return (ALL_COMPETITOR_FETCH_STATUSES as readonly string[]).includes(value);
}

/** C.1: "Máximo 3 sitios por organización" — sin CHECK a nivel de base, se aplica en la ruta. */
export const MAX_COMPETITOR_SITES_PER_ORG = 3;

/** Identifica el bot ante `robots.txt` y ante el propio sitio (C.2). */
export const COMPETITOR_BOT_USER_AGENT = 'Datagol-CompetitorBot/1.0 (+https://datagol.net/bot)';

export interface CompetitorSiteRecord {
    id: string;
    organization_id: string;
    url: string;
    label: string | null;
    enabled: boolean;
    last_checked_at: string | null;
    last_error: string | null;
    created_at: string;
}

/**
 * Resultado de un sitio ya comparado, listo para incluirse en los datos del
 * reporte ejecutivo (weekly-report-service.ts).
 */
export interface CompetitorSiteAnalysis {
    siteId: string;
    label: string | null;
    url: string;
    status: CompetitorFetchStatus;
    error?: string | null;
    /** `true` en la primera semana con snapshot — sin comparación posible (C.3). */
    isBaseline: boolean;
    addedLines: string[];
    removedLines: string[];
}

export interface CompetitorAnalysisReportData {
    /** Siempre `true` — C.4 exige etiquetar la sección como aproximada. */
    approximate: true;
    sites: CompetitorSiteAnalysis[];
}
