import { FastifyInstance } from 'fastify';
import { getSecret } from '../secret-service.js';
import { getLlmConfig, recordLlmUsage } from '../llm-config-service.js';
import { LlmProviderFactory } from '../llm/LlmProviderFactory.js';
import { SECRET_KEYS } from '../../types/secret-keys.js';
import { type ResolvedPeriod } from '../../types/natural-reports.js';

const NARRATIVE_MAX_OUTPUT_TOKENS = 250;
const ALWAYS_ALLOWED_MAX = 12;
const NUMBER_TOLERANCE = 0.05;

function extractNumbersFromText(text: string): number[] {
    const matches = text.match(/\d[\d,]*\.?\d*/g) || [];
    return matches.map((m) => Number(m.replace(/,/g, ''))).filter((n) => Number.isFinite(n));
}

function addWithRounding(acc: Set<number>, n: number): void {
    acc.add(n);
    acc.add(Math.round(n));
    acc.add(Math.round(n * 10) / 10);
    acc.add(Math.round(n * 100) / 100);
}

export function flattenNumbers(value: unknown, acc: Set<number> = new Set()): Set<number> {
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

export function verifyNarrativeNumbers(text: string, data: unknown): { ok: boolean; unmatched: number[] } {
    const numbersInText = extractNumbersFromText(text);
    const allowedNumbers = flattenNumbers(data);
    const unmatched = numbersInText.filter((n) => !numberMatchesAny(n, allowedNumbers));
    return { ok: unmatched.length === 0, unmatched };
}

export function buildNarrativePrompt(
    question: string,
    interpretation: string,
    period: ResolvedPeriod,
    data: unknown
): string {
    return `Eres un analista de negocios ejecutivo para Datagol. Redacta UNA SOLA frase o máximo dos oraciones en español mexicano que resuma el contexto clave de los datos calculados para responder a la pregunta del usuario.

REGLAS ESTRICTAS:
1. Usa ÚNICAMENTE las cifras exactas provistas en el bloque DATOS. PROHIBIDO inventar, estimar o aproximar números que no estén presentes.
2. Sé directo, profesional y conciso (máximo 40 palabras).
3. No saludes ni des introducciones como "Claro", "Aquí tienes".
4. Devuelve ÚNICAMENTE el texto de la frase en texto plano, sin comillas adicionales ni bloques de código.

Pregunta del usuario: "${question}"
Interpretación: "${interpretation}"
Periodo: "${period.label}"
DATOS (ya calculados y exactos):
${JSON.stringify(data)}`;
}

export interface GenerateNarrativeParams {
    question: string;
    interpretation: string;
    period: ResolvedPeriod;
    data: unknown;
}

/**
 * Redacta una frase de contexto para el resultado numérico y verifica que no contenga cifras inventadas.
 * Si la verificación falla o hay error de proveedor, devuelve `null` de forma segura.
 */
export async function generateNarrative(
    fastify: FastifyInstance,
    organizationId: string,
    params: GenerateNarrativeParams
): Promise<string | null> {
    const config = await getLlmConfig(fastify, organizationId);
    if (!config.provider || !config.model) {
        return null;
    }

    const apiKey = await getSecret(organizationId, SECRET_KEYS.LLM_API_KEY);
    if (!apiKey) {
        return null;
    }

    const prompt = buildNarrativePrompt(params.question, params.interpretation, params.period, params.data);
    const provider = LlmProviderFactory.getProvider(config.provider);

    try {
        const result = await provider.complete({
            apiKey,
            model: config.model,
            prompt,
            baseUrl: config.baseUrl ?? undefined,
            maxOutputTokens: NARRATIVE_MAX_OUTPUT_TOKENS,
        });

        const narrativeText = result.text.trim().replace(/^["']|["']$/g, '');
        if (!narrativeText) {
            return null;
        }

        // Verificación anti-alucinación
        const verification = verifyNarrativeNumbers(narrativeText, {
            ...((params.data && typeof params.data === 'object' ? params.data : { data: params.data }) as Record<string, unknown>),
            period: params.period,
        });

        if (!verification.ok) {
            fastify.log.warn(
                { organizationId, unmatched: verification.unmatched, narrative: narrativeText },
                '[NlNarrative] Cifra no reconocida en la frase de contexto generada, se descarta la redacción'
            );
            return null;
        }

        await recordLlmUsage(fastify, organizationId, config, result);
        return narrativeText;
    } catch (err) {
        fastify.log.warn({ err, organizationId }, '[NlNarrative] Error al generar la narrativa contextual, fallback a solo datos');
        return null;
    }
}
