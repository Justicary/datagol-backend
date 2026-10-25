import { FastifyInstance } from 'fastify';
import { getSecret } from '../secret-service.js';
import { getLlmConfig, recordLlmUsage } from '../llm-config-service.js';
import { LlmProviderFactory } from '../llm/LlmProviderFactory.js';
import { SECRET_KEYS } from '../../types/secret-keys.js';
import {
    type NlTranslationResult,
    type NlIntentKey,
} from '../../types/natural-reports.js';
import type { TelegramConversationTurn } from '../../types/telegram.js';
import { rawLlmTranslationSchema } from '../../schemas/natural-reports.js';
import { getIntentCatalogPromptText, getIntentByKey } from './intents/index.js';
import { getZonedDateParts, DEFAULT_TIMEZONE } from './nl-dimensions.js';
import { tryTranslateWithJev } from './nl-jev-translation.js';

const TRANSLATION_MAX_OUTPUT_TOKENS = 1500;

const DAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS_ES = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export function buildTranslationPrompt(
    question: string,
    timezone: string = DEFAULT_TIMEZONE,
    now: Date = new Date(),
    conversationContext?: readonly TelegramConversationTurn[]
): string {
    const zoned = getZonedDateParts(now, timezone);
    const dayOfWeek = DAYS_ES[new Date(Date.UTC(zoned.year, zoned.month - 1, zoned.day)).getUTCDay()];
    const fechaActualStr = `${dayOfWeek} ${zoned.day} de ${MONTHS_ES[zoned.month - 1]} de ${zoned.year}`;

    const catalogText = getIntentCatalogPromptText();

    const hasTurns = Boolean(conversationContext && conversationContext.length > 0);
    const turnsBlock = hasTurns
        ? `\nTURNOS PREVIOS DE LA CONVERSACIÓN (del más antiguo al más reciente):
${conversationContext!
    .map(
        (t, idx) =>
            `${idx + 1}. Pregunta: "${t.question}" -> Intención: "${t.intent}", Parámetros: ${JSON.stringify(
                t.parameters
            )}, Resumen: "${t.resultDigest}"`
    )
    .join('\n')}

REGLA DE CONTINUIDAD CONVERSACIONAL:
- Si la pregunta actual hace referencia implícita o anafórica a un turno previo (ej. "¿y la semana pasada?", "¿y por WhatsApp?", "dame sus nombres", "¿cuántos fueron ayer?"), resuelve la referencia heredando la intención o los parámetros relevantes del último turno y aplicando el cambio solicitado, SIEMPRE que el resultado sea una de las 22 intenciones válidas del catálogo oficial.
- Si al heredar el contexto la consulta pide algo que NO existe en las 22 intenciones del catálogo, responde con status "no_resuelta". NUNCA inventes intenciones ni aproximes fuera del catálogo.\n`
        : '';

    return `Eres un clasificador semántico de consultas de negocio para Datagol. Tu única tarea es traducir la pregunta del usuario en español a una intención estructurada del catálogo oficial.

CONTEXTO TEMPORAL ACTUAL:
- Fecha local del negocio: ${fechaActualStr}
- Zona horaria del negocio: ${timezone}

CATÁLOGO OFICIAL DE INTENCIONES (ÚNICAS PERMITIDAS):
${catalogText}

DIMENSIONES TEMPORALES VÁLIDAS PARA "periodo":
- "type": "hoy" | "ayer" | "esta_semana" | "semana_pasada" | "este_mes" | "mes_pasado" | "ultimos_n_dias" (con "n": number) | "rango_explicito" (con "inicio": "YYYY-MM-DD", "fin": "YYYY-MM-DD")
Si el usuario no especifica periodo, usa por defecto: {"type": "este_mes"}.
${turnsBlock}
REGLAS DURAS OBLIGATORIAS:
1. Elige EXACTAMENTE UNA intención del catálogo si la pregunta encaja con claridad (por ejemplo, "¿Tenemos correos electrónicos pendientes?" corresponde a "resumen_correos_recibidos" con {"soloNoLeidos": true}).
2. Si la pregunta es ambigua, demasiado vaga (ejemplo: "¿cómo voy?", "¿está bien?", "¿qué pasó?") o pregunta qué tipo de consultas o reportes puedes contestar (ejemplo: "¿qué tipo de preguntas te puedo hacer?", "¿qué puedes responder?"), responde con status "requiere_aclaracion" e indica en "preguntaAclaracion" las áreas disponibles: Agenda (citas), Pendientes (prospectos abiertos y seguimientos vencidos), Captación (prospectos nuevos y conversaciones), Costos, Resultados (ventas y conversión) y Correos (enviados, con error o recibidos en el buzón).
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
        let cleaned = text
            .trim()
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            cleaned = cleaned.slice(firstBrace, lastBrace + 1);
        }
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
    conversationContext?: readonly TelegramConversationTurn[];
    channel?: 'dashboard' | 'telegram';
    conversationId?: string;
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

    // Camino rápido opcional: si la organización tiene Jev validado y NO hay
    // turnos previos en contexto conversacional (Jev evalúa solo la pregunta
    // aislada sin ver turnos previos), intenta clasificar con Jev.
    const hasConversationContext = Boolean(
        params.conversationContext && params.conversationContext.length > 0
    );
    if (!hasConversationContext) {
        const jevAttempt = await tryTranslateWithJev(fastify, organizationId, params.question);
        if (jevAttempt.status === 'resolved') {
            fastify.log.info(
                { organizationId, path: 'jev', intent: jevAttempt.result.intent, confidence: jevAttempt.confidence },
                '[NlTranslation] Pregunta traducida con Jev'
            );
            return jevAttempt.result;
        }
        if (jevAttempt.reason !== 'jev_no_configurado') {
            fastify.log.info(
                { organizationId, path: 'llm', jevFallbackReason: jevAttempt.reason, detail: jevAttempt.detail },
                '[NlTranslation] Jev no resolvió la pregunta, se traduce con el LLM'
            );
        }
    } else {
        fastify.log.info(
            { organizationId, path: 'llm', jevFallbackReason: 'contexto_conversacional_activo' },
            '[NlTranslation] Contexto conversacional activo, se traduce con el LLM'
        );
    }

    const prompt = buildTranslationPrompt(
        params.question,
        params.timezone,
        params.now,
        params.conversationContext
    );
    const provider = LlmProviderFactory.getProvider(config.provider);

    try {
        const result = await provider.complete({
            apiKey,
            model: config.model,
            prompt,
            baseUrl: config.baseUrl ?? undefined,
            maxOutputTokens: TRANSLATION_MAX_OUTPUT_TOKENS,
        });

        const usageMetadata =
            params.channel || params.conversationId
                ? {
                      ...(params.channel ? { channel: params.channel } : {}),
                      ...(params.conversationId ? { conversationId: params.conversationId } : {}),
                  }
                : undefined;

        if (usageMetadata) {
            await recordLlmUsage(fastify, organizationId, config, result, usageMetadata);
        } else {
            await recordLlmUsage(fastify, organizationId, config, result);
        }

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
