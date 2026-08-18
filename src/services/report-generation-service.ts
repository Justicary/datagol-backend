import { FastifyInstance } from 'fastify';
import { getSecret } from './secret-service.js';
import { getLlmConfig, recordLlmUsage } from './llm-config-service.js';
import { LlmProviderFactory } from './llm/LlmProviderFactory.js';
import { SECRET_KEYS } from '../types/secret-keys.js';
import { REPORT_TYPES, type ReportType } from '../types/reports.js';
import { hasReportActivity, type ReportData } from './report-data-service.js';

const MAX_ATTEMPTS = 2;
const MAX_OUTPUT_TOKENS = 1200;
/** Números pequeños (enumeraciones, "top 3", porcentajes redondos) que no
 * cuentan como una cifra de negocio inventada — evita falsos positivos de la
 * verificación anti-alucinación sobre conectores de prosa normales. */
const ALWAYS_ALLOWED_MAX = 12;
const NUMBER_TOLERANCE = 0.05;

const REPORT_TYPE_LABELS: Record<ReportType, string> = {
    [REPORT_TYPES.PLANNING]: 'reporte de planificación semanal (lunes)',
    [REPORT_TYPES.EXECUTIVE]: 'reporte ejecutivo semanal (viernes)',
};

export interface GenerateReportNarrativeResult {
    narrative: string | null;
    recommendations: string[];
    /** `true` si se agotaron los 2 intentos y se cae al reporte sin prosa (B.3). */
    usedFallback: boolean;
}

/**
 * Construye el prompt de generación. El LLM redacta, nunca calcula — reglas
 * duras de docs/tasks/reportes-semanales.md §B.3. Se pide JSON estructurado
 * (no prosa libre) para poder separar narrativa de recomendaciones sin un
 * segundo parseo heurístico.
 */
function buildWeeklyReportPrompt(reportType: ReportType, data: ReportData): string {
    const hasCompetitorAnalysis = Boolean((data as { competitorAnalysis?: unknown }).competitorAnalysis);

    // Regla adicional de la Fase C (C.4) — solo cuando el objeto de datos
    // trae `competitorAnalysis`, para no ensuciar el prompt de reportes que
    // no tienen esa sección habilitada.
    const competitorRule = hasCompetitorAnalysis
        ? '\n- La sección de competencia ("competitorAnalysis") es aproximada y basada en contenido público de la competencia. Prohibido especular sobre lo que NO está en las líneas de "addedLines"/"removedLines" — no inventes motivos, precios ni intenciones de la competencia. Menciona explícitamente si un sitio reportó un error (bloqueado por robots.txt, caído, etc.), no lo omitas en silencio. Deja claro en tu redacción que esta sección es aproximada.'
        : '';

    return `Eres un asistente que redacta el ${REPORT_TYPE_LABELS[reportType]} de un negocio que usa Datagol AI para atender prospectos y agendar citas.

Reglas obligatorias, sin excepción:
- Usa ÚNICAMENTE las cifras que aparecen en el objeto de datos de abajo. Nunca inventes, redondees de forma engañosa, ni estimes un número que no esté ahí.
- Nunca infieras causalidad que los datos no sostengan (ej. no afirmes "bajó por X" si no hay un dato que lo respalde).
- Máximo 3 recomendaciones, accionables y concretas.
- Español mexicano, tono profesional y directo.
- Si un dato viene vacío, nulo, o es una lista vacía, simplemente omítelo — no lo rellenes ni inventes que "no se especificó".${competitorRule}

Devuelve tu respuesta ÚNICAMENTE como un objeto JSON con esta forma exacta, sin texto antes ni después, sin bloque de código:
{"narrative": "prosa del reporte en 2 a 4 párrafos", "recommendations": ["recomendación 1", "recomendación 2"]}

Datos (ya calculados, no los recalcules):
${JSON.stringify(data)}`;
}

function parseNarrativeResponse(text: string): { narrative: string; recommendations: string[] } | null {
    try {
        const cleaned = text
            .trim()
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '');
        const parsed = JSON.parse(cleaned);
        if (typeof parsed.narrative !== 'string' || parsed.narrative.trim() === '' || !Array.isArray(parsed.recommendations)) {
            return null;
        }
        return {
            narrative: parsed.narrative,
            recommendations: parsed.recommendations.filter((r: unknown): r is string => typeof r === 'string' && r.trim() !== ''),
        };
    } catch {
        return null;
    }
}

function extractNumbersFromText(text: string): number[] {
    const matches = text.match(/\d[\d,]*\.?\d*/g) || [];
    return matches.map((m) => Number(m.replace(/,/g, ''))).filter((n) => Number.isFinite(n));
}

function addWithRounding(acc: Set<number>, n: number): void {
    acc.add(n);
    acc.add(Math.round(n));
    acc.add(Math.round(n * 10) / 10);
}

/**
 * Aplana TODOS los números que aparecen en el objeto de datos — incluidos
 * los incrustados en strings (fechas ISO, teléfonos, IDs) — para minimizar
 * falsos positivos: un número que el LLM tomó de una fecha o un teléfono
 * real no es una cifra inventada, aunque no sea un `number` de JS.
 */
function flattenNumbers(value: unknown, acc: Set<number> = new Set()): Set<number> {
    if (typeof value === 'number' && Number.isFinite(value)) {
        addWithRounding(acc, value);
    } else if (typeof value === 'string') {
        const embedded = value.match(/\d+(\.\d+)?/g) || [];
        for (const m of embedded) addWithRounding(acc, Number(m));
    } else if (Array.isArray(value)) {
        for (const v of value) flattenNumbers(v, acc);
    } else if (value && typeof value === 'object') {
        for (const v of Object.values(value)) flattenNumbers(v, acc);
    }
    return acc;
}

function numberMatchesAny(n: number, allowed: Set<number>): boolean {
    if (n <= ALWAYS_ALLOWED_MAX) return true;
    for (const a of allowed) {
        if (Math.abs(a - n) <= NUMBER_TOLERANCE) return true;
    }
    return false;
}

/**
 * Verificación post-generación (B.3): cualquier número en el texto que no
 * corresponda a ningún valor real de `data` (con tolerancia de redondeo)
 * marca la generación como no confiable. Prefiere falsos positivos
 * (descartar una generación válida) a falsos negativos (aceptar una cifra
 * inventada) — el propio doc de tarea acepta el fallback sin prosa como
 * resultado válido.
 */
export function verifyNarrativeNumbers(text: string, data: ReportData): { ok: boolean; unmatched: number[] } {
    const numbersInText = extractNumbersFromText(text);
    const allowedNumbers = flattenNumbers(data);
    const unmatched = numbersInText.filter((n) => !numberMatchesAny(n, allowedNumbers));
    return { ok: unmatched.length === 0, unmatched };
}

/**
 * Genera la narrativa del reporte semanal con verificación anti-alucinación
 * y reintento. Si la organización no tiene actividad esa semana, no llama al
 * LLM (ahorra tokens BYOK, cero riesgo de inventar contenido sobre datos
 * vacíos). Si no hay configuración/llave de LLM, o se agotan los intentos,
 * cae a `usedFallback: true` — el llamador arma el reporte solo con las
 * secciones tabulares (`sections` en weekly-report-service.ts), sin prosa.
 */
export async function generateReportNarrative(
    fastify: FastifyInstance,
    organizationId: string,
    reportType: ReportType,
    data: ReportData
): Promise<GenerateReportNarrativeResult> {
    if (!hasReportActivity(reportType, data)) {
        return {
            narrative: 'Esta semana no hubo actividad registrada.',
            recommendations: [],
            usedFallback: false,
        };
    }

    const config = await getLlmConfig(fastify, organizationId);
    if (!config.provider || !config.model) {
        fastify.log.warn({ organizationId, reportType }, '[ReportGeneration] Sin configuración de LLM, se usa reporte sin prosa');
        return { narrative: null, recommendations: [], usedFallback: true };
    }

    const apiKey = await getSecret(organizationId, SECRET_KEYS.LLM_API_KEY);
    if (!apiKey) {
        fastify.log.warn({ organizationId, reportType }, '[ReportGeneration] Sin llave de LLM, se usa reporte sin prosa');
        return { narrative: null, recommendations: [], usedFallback: true };
    }

    const provider = LlmProviderFactory.getProvider(config.provider);
    const prompt = buildWeeklyReportPrompt(reportType, data);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const result = await provider.complete({
                apiKey,
                model: config.model,
                prompt,
                baseUrl: config.baseUrl ?? undefined,
                maxOutputTokens: MAX_OUTPUT_TOKENS,
            });

            const parsed = parseNarrativeResponse(result.text);
            if (!parsed) {
                fastify.log.warn({ organizationId, reportType, attempt }, '[ReportGeneration] Respuesta del LLM no es JSON válido, reintentando');
                continue;
            }

            const verification = verifyNarrativeNumbers(`${parsed.narrative} ${parsed.recommendations.join(' ')}`, data);
            if (!verification.ok) {
                fastify.log.warn(
                    { organizationId, reportType, attempt, unmatched: verification.unmatched },
                    '[ReportGeneration] Cifra no reconocida en la generación, se descarta y reintenta'
                );
                continue;
            }

            await recordLlmUsage(fastify, organizationId, config, result);

            return {
                narrative: parsed.narrative,
                recommendations: parsed.recommendations.slice(0, 3),
                usedFallback: false,
            };
        } catch (err) {
            fastify.log.warn({ organizationId, reportType, attempt, err }, '[ReportGeneration] Error llamando al proveedor de LLM, reintentando');
        }
    }

    fastify.log.warn({ organizationId, reportType }, '[ReportGeneration] Dos intentos fallidos, se usa reporte sin prosa');
    return { narrative: null, recommendations: [], usedFallback: true };
}
