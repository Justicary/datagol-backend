import { FastifyInstance } from 'fastify';
import { getSecret } from '../secret-service.js';
import { getLlmConfig, recordLlmUsage } from '../llm-config-service.js';
import { LlmProviderFactory } from '../llm/LlmProviderFactory.js';
import { SECRET_KEYS } from '../../types/secret-keys.js';
import {
    type NlTranslationResult,
    type NlIntentKey,
} from '../../types/natural-reports.js';
import { rawLlmTranslationSchema } from '../../schemas/natural-reports.js';
import { getIntentCatalogPromptText, getIntentByKey } from './intents/index.js';
import { getZonedDateParts, DEFAULT_TIMEZONE } from './nl-dimensions.js';

const TRANSLATION_MAX_OUTPUT_TOKENS = 600;

const DAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS_ES = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export function buildTranslationPrompt(
    question: string,
    timezone: string = DEFAULT_TIMEZONE,
    now: Date = new Date()
): string {
    const zoned = getZonedDateParts(now, timezone);
    const dayOfWeek = DAYS_ES[new Date(Date.UTC(zoned.year, zoned.month - 1, zoned.day)).getUTCDay()];
    const fechaActualStr = `${dayOfWeek} ${zoned.day} de ${MONTHS_ES[zoned.month - 1]} de ${zoned.year}`;

    const catalogText = getIntentCatalogPromptText();

    return `Eres un clasificador semántico de consultas de negocio para Datagol. Tu única tarea es traducir la pregunta del usuario en español a una intención estructurada del catálogo oficial.

CONTEXTO TEMPORAL ACTUAL:
- Fecha local del negocio: ${fechaActualStr}
- Zona horaria del negocio: ${timezone}

CATÁLOGO OFICIAL DE INTENCIONES (ÚNICAS PERMITIDAS):
${catalogText}

DIMENSIONES TEMPORALES VÁLIDAS PARA "periodo":
- "type": "hoy" | "ayer" | "esta_semana" | "semana_pasada" | "este_mes" | "mes_pasado" | "ultimos_n_dias" (con "n": number) | "rango_explicito" (con "inicio": "YYYY-MM-DD", "fin": "YYYY-MM-DD")
Si el usuario no especifica periodo, usa por defecto: {"type": "este_mes"}.

REGLAS DURAS OBLIGATORIAS:
1. Elige EXACTAMENTE UNA intención del catálogo si la pregunta encaja con claridad.
2. Si la pregunta es ambigua o demasiado vaga (ejemplo: "¿cómo voy?", "¿está bien?", "¿qué pasó?"), responde con status "requiere_aclaracion" y una pregunta de vuelta en "preguntaAclaracion".
3. Si la pregunta pide algo fuera del catálogo de 22 intenciones (ej. pipeline detallado, nóminas, configuración técnica de IA, inventarios), responde con status "no_resuelta". NUNCA aproximes a la intención más cercana si no corresponde.
4. PROHIBIDO inventar intenciones o parámetros.
5. "interpretation": SIEMPRE incluye una breve frase en español llano que resuma lo que entendiste (ej. "Prospectos nuevos, canal WhatsApp, mes pasado").

Devuelve ÚNICAMENTE un objeto JSON válido con una de estas 3 formas, sin bloques de código ni texto adicional:

Forma 1 (Éxito):
{"status": "success", "intent": "<clave_intencion>", "parameters": {"periodo": {"type": "este_mes"}, "status": "opcional"}, "interpretation": "Resumen de lo entendido"}

Forma 2 (Aclaración):
{"status": "requiere_aclaracion", "preguntaAclaracion": "¿Te refieres a las citas agendadas o a los prospectos captados?", "interpretation": "Pregunta ambigua"}

Forma 3 (No resuelta):
{"status": "no_resuelta", "reason": "La consulta solicita métricas de inventario no disponibles en el catálogo.", "interpretation": "Consulta fuera de alcance"}

PREGUNTA DEL USUARIO:
"${question}"`;
}

function parseTranslationResponse(text: string): NlTranslationResult | null {
    try {
        const cleaned = text
            .trim()
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '');
        const json = JSON.parse(cleaned);
        const parsed = rawLlmTranslationSchema.safeParse(json);
        if (!parsed.success) {
            return null;
        }

        const data = parsed.data;
        if (data.status === 'success') {
            // Verificar que la intención realmente exista en el catálogo
            if (!getIntentByKey(data.intent)) {
                return {
                    status: 'no_resuelta',
                    reason: `La intención '${data.intent}' no existe en el catálogo oficial v1.`,
                    interpretation: data.interpretation || 'Intención no reconocida',
                };
            }

            return {
                status: 'success',
                intent: data.intent as NlIntentKey,
                parameters: data.parameters || {},
                interpretation: data.interpretation,
            };
        } else if (data.status === 'requiere_aclaracion') {
            return {
                status: 'requiere_aclaracion',
                preguntaAclaracion: data.preguntaAclaracion,
                interpretation: data.interpretation,
            };
        } else {
            return {
                status: 'no_resuelta',
                reason: data.reason,
                interpretation: data.interpretation,
            };
        }
    } catch {
        return null;
    }
}

export interface TranslateQuestionParams {
    question: string;
    timezone?: string;
    now?: Date;
}

export async function translateQuestion(
    fastify: FastifyInstance,
    organizationId: string,
    params: TranslateQuestionParams
): Promise<NlTranslationResult> {
    const config = await getLlmConfig(fastify, organizationId);
    if (!config.provider || !config.model) {
        return {
            status: 'no_resuelta',
            reason: 'La organización no tiene configurado un proveedor de LLM (BYOK).',
            interpretation: 'Falta configuración de IA',
        };
    }

    const apiKey = await getSecret(organizationId, SECRET_KEYS.LLM_API_KEY);
    if (!apiKey) {
        return {
            status: 'no_resuelta',
            reason: 'No hay una llave de API de LLM guardada para esta organización.',
            interpretation: 'Falta llave de IA',
        };
    }

    const prompt = buildTranslationPrompt(params.question, params.timezone, params.now);
    const provider = LlmProviderFactory.getProvider(config.provider);

    try {
        const result = await provider.complete({
            apiKey,
            model: config.model,
            prompt,
            baseUrl: config.baseUrl ?? undefined,
            maxOutputTokens: TRANSLATION_MAX_OUTPUT_TOKENS,
        });

        await recordLlmUsage(fastify, organizationId, config, result);

        const parsed = parseTranslationResponse(result.text);
        if (!parsed) {
            fastify.log.warn(
                { organizationId, rawOutput: result.text },
                '[NlTranslation] La respuesta del LLM no cumplió el esquema Zod o no fue JSON válido'
            );
            return {
                status: 'no_resuelta',
                reason: 'No se pudo estructurar la consulta a partir de la respuesta del modelo.',
                interpretation: 'Consulta no comprendida',
            };
        }

        return parsed;
    } catch (err) {
        fastify.log.error({ err, organizationId }, '[NlTranslation] Error invocando al proveedor de LLM');
        return {
            status: 'no_resuelta',
            reason: 'Ocurrió un error al contactar al proveedor de LLM para traducir la pregunta.',
            interpretation: 'Error en servicio de IA',
        };
    }
}
