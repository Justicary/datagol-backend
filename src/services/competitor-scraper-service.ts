import { isPathAllowed } from '../lib/robots-txt.js';
import { extractVisibleText } from '../lib/html-text-extractor.js';
import { COMPETITOR_BOT_USER_AGENT, COMPETITOR_FETCH_STATUSES, type CompetitorFetchStatus } from '../types/competitor-analysis.js';

const FETCH_TIMEOUT_MS = 8_000;
/** Evita guardar textos absurdamente largos de sitios con mucho contenido. */
const MAX_TEXT_LENGTH = 20_000;

export interface CheckCompetitorSiteResult {
    status: CompetitorFetchStatus;
    text?: string;
    error?: string;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': COMPETITOR_BOT_USER_AGENT },
            redirect: 'follow',
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Revisa un sitio de la competencia (C.2, docs/tasks/reportes-semanales.md):
 * respeta `robots.txt`, pide ÚNICAMENTE la URL indicada (nunca sigue
 * enlaces), timeout corto y sin reintentos, y devuelve solo texto extraído
 * (nunca el HTML). Nunca lanza — cualquier falla se clasifica en `status`.
 */
export async function checkCompetitorSite(url: string): Promise<CheckCompetitorSiteResult> {
    let target: URL;
    try {
        target = new URL(url);
    } catch {
        return { status: COMPETITOR_FETCH_STATUSES.HTTP_ERROR, error: 'URL inválida' };
    }

    // 1. robots.txt. Un robots.txt ausente, con error, o inalcanzable se
    // trata como "permite todo" — mismo comportamiento estándar que cuando
    // el archivo no existe; no vale la pena bloquear el análisis completo
    // por la falla de un archivo opcional.
    let robotsTxt = '';
    try {
        const robotsResponse = await fetchWithTimeout(`${target.origin}/robots.txt`, FETCH_TIMEOUT_MS);
        if (robotsResponse.ok) {
            robotsTxt = await robotsResponse.text();
        }
    } catch {
        // Ver nota arriba — se continúa como si permitiera todo.
    }

    if (robotsTxt && !isPathAllowed(robotsTxt, COMPETITOR_BOT_USER_AGENT, target.pathname)) {
        return {
            status: COMPETITOR_FETCH_STATUSES.BLOCKED_BY_ROBOTS,
            error: 'robots.txt prohíbe esta ruta para nuestro user-agent',
        };
    }

    // 2. La página en sí — solo esta URL, sin seguir enlaces.
    try {
        const response = await fetchWithTimeout(target.toString(), FETCH_TIMEOUT_MS);
        if (!response.ok) {
            return { status: COMPETITOR_FETCH_STATUSES.HTTP_ERROR, error: `HTTP ${response.status}` };
        }
        const html = await response.text();
        const text = extractVisibleText(html).slice(0, MAX_TEXT_LENGTH);
        return { status: COMPETITOR_FETCH_STATUSES.OK, text };
    } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        return {
            status: isAbort ? COMPETITOR_FETCH_STATUSES.TIMEOUT : COMPETITOR_FETCH_STATUSES.NETWORK_ERROR,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
