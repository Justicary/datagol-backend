import { z } from 'zod';
import { normalizePhoneE164 } from './phone-normalization.js';
import { isLeadTemperature, type LeadTemperature, LEAD_CHANNELS, type LeadChannel } from '../types/lead-enums.js';

/**
 * Esquema mínimo del webhook `post_call_transcription` de ElevenLabs.
 * Solo se validan los campos que este servicio efectivamente consume.
 * Ver: https://elevenlabs.io/docs/agents-platform/workflows/post-call-webhooks
 */
const dataCollectionEntrySchema = z.union([
    z.object({ value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional() }).passthrough(),
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
]);

const elevenLabsWebhookSchema = z.object({
    type: z.string(),
    event_timestamp: z.number().optional(),
    data: z.object({
        agent_id: z.string(),
        conversation_id: z.string(),
        transcript: z
            .array(
                z.object({
                    role: z.string().optional(),
                    message: z.string().nullable().optional(),
                })
            )
            .optional(),
        analysis: z
            .object({
                transcript_summary: z.string().optional(),
                data_collection_results: z.record(z.string(), dataCollectionEntrySchema).optional(),
            })
            .optional(),
        metadata: z
            .object({
                call_duration_secs: z.number().optional(),
                start_time_unix_secs: z.number().optional(),
                // Llamadas sin tramo telefónico (widget web) mandan
                // `phone_call: null` explícito, no la omiten — `.optional()`
                // solo acepta `undefined`. El resto del código ya maneja
                // `null` vía optional chaining (`data.metadata?.phone_call?.…`,
                // `Boolean(data.metadata?.phone_call)`), así que el único
                // cambio necesario es aceptar `null` aquí también.
                phone_call: z
                    .object({
                        external_number: z.string().optional(),
                        agent_number: z.string().optional(),
                        direction: z.string().optional(),
                    })
                    .passthrough()
                    .nullable()
                    .optional(),
                // Discriminador de canal (docs oficiales de ElevenLabs, campo
                // `metadata.conversation_initiation_source`, enum que incluye
                // 'whatsapp' — verificado contra
                // https://elevenlabs.io/docs/api-reference/conversations/get,
                // no asumido). `text_only` es el mismo concepto en forma de
                // booleano — se acepta cualquiera de los dos como señal de
                // canal de texto.
                conversation_initiation_source: z.string().optional(),
                text_only: z.boolean().optional(),
                // Facturación de mensajería de ElevenLabs para canales de
                // texto (WhatsApp hoy). `category_usage` es un mapa por
                // categoría (no un objeto fijo) — 'text_message' es la clave
                // que corresponde a mensajes de WhatsApp salientes/entrantes
                // del agente; no confundir con las tarifas de plantilla de
                // Meta (`provider: 'meta'` en `provider_rates`), que son un
                // costo aparte que este job no cubre.
                platform_usage: z
                    .object({
                        category_usage: z
                            .record(z.string(), z.object({ quantity: z.number().optional() }).passthrough())
                            .optional(),
                    })
                    .passthrough()
                    .optional(),
                // Continuidad cross-canal: en conversaciones de WhatsApp no hay
                // `phone_call` — el identificador del contacto viaja aquí. Caso
                // real verificado contra un webhook de producción: whatsapp_user_id
                // llega como '5212213528341' (sin '+', con el "1" histórico de
                // trunk móvil de México) — normalizePhoneE164 ya lo resuelve al
                // mismo +522213528341 que un contacto de voz previo (fix de
                // phone-normalization.ts de esta misma sesión).
                whatsapp: z
                    .object({
                        whatsapp_user_id: z.string().optional(),
                    })
                    .passthrough()
                    .nullable()
                    .optional(),
                // Tokens de LLM (metering, cierra el hueco del 14% de la
                // factura). Estructura verificada contra payloads reales de
                // producción, no contra la documentación pública (que no la
                // detalla): `charging.llm_usage.irreversible_generation.model_usage`
                // es un mapa por modelo (ej. 'gemini-2.5-flash', 'gpt-4o'), cada
                // uno con `input`/`output_total` (los únicos con `price` > 0 en
                // los ejemplos reales — `input_cache_read`/`input_cache_write`
                // siempre traen price:0, así que no se registran). Se usa
                // `irreversible_generation`, nunca `initiated_generation`: esta
                // última cuenta reintentos del LLM que no llegaron a facturarse,
                // contarla duplicaría tokens.
                charging: z
                    .object({
                        llm_usage: z
                            .object({
                                irreversible_generation: z
                                    .object({
                                        model_usage: z
                                            .record(
                                                z.string(),
                                                z
                                                    .object({
                                                        input: z.object({ tokens: z.number().optional() }).passthrough().optional(),
                                                        output_total: z.object({ tokens: z.number().optional() }).passthrough().optional(),
                                                    })
                                                    .passthrough()
                                            )
                                            .optional(),
                                    })
                                    .passthrough()
                                    .optional(),
                            })
                            .passthrough()
                            .optional(),
                    })
                    .passthrough()
                    .optional(),
            })
            .passthrough()
            .optional(),
    }),
});

/**
 * Consumo de tokens de un modelo LLM dentro de una conversación, ya separado
 * por input/output (tarifas por token distintas — ver
 * usage-event-unit-type.ts). `model` es la clave cruda del mapa
 * `model_usage` del payload (ej. 'gemini-2.5-flash'), nunca normalizada ni
 * validada contra una lista — un modelo nuevo que ElevenLabs empiece a usar
 * simplemente no tendrá tarifa en `provider_rates` todavía, y el resolver de
 * metering lo omite con un warn en vez de inventar un precio.
 */
export interface LlmModelTokenUsage {
    model: string;
    inputTokens: number;
    outputTokens: number;
}

export interface MappedCallData {
    conversationId: string;
    agentId: string;
    providerCallId: string;
    transcript: string;
    summary: string | null;
    durationSeconds: number;
    callerPhoneE164: string | null;
    contactPhoneRaw: string | null;
    fullName: string | null;
    email: string | null;
    businessName: string | null;
    businessSector: string | null;
    inquiryReason: string | null;
    temperature: LeadTemperature | null;
    bookedAppointment: boolean;
    needsFollowup: boolean;
    followupNotes: string | null;
    callVolume: string | null;
    /**
     * Instante real en que ocurrió la llamada (inicio de la conversación),
     * usado por el metering de Fase 3 para resolver la tarifa vigente en esa
     * fecha — nunca la tarifa vigente al momento de procesar el webhook, que
     * puede llegar con retraso (reintentos de pg-boss). Toma
     * `metadata.start_time_unix_secs`, luego el `event_timestamp` del
     * webhook; si ninguno viene, usa el instante de mapeo como última opción.
     */
    occurredAt: Date;
    /**
     * `true` únicamente si el payload trae `data.metadata.phone_call` (llamada
     * real por SIP/PSTN vía Telnyx). Ausente en conversaciones de widget web:
     * esas no tienen un tramo de telefonía que medir en Fase 3.
     */
    hasPhoneCallLeg: boolean;
    /**
     * `true` si el canal es de texto (WhatsApp hoy: `conversation_initiation_source
     * === 'whatsapp'` o `text_only === true`). `agent_minute` no aplica a estas
     * conversaciones — ElevenLabs no sintetiza audio, `call_duration_secs` no
     * mide minutos de voz aquí. El metering de Fase 3 debe ramificar en este
     * flag, nunca derivar consumo de `durationSeconds` cuando es `true`.
     */
    isTextChannel: boolean;
    /**
     * `metadata.platform_usage.category_usage.text_message.quantity` — cantidad
     * de mensajes de WhatsApp de la conversación, ya resuelta por ElevenLabs.
     * `null` cuando el payload no trae ese desglose (payload no-WhatsApp, o
     * WhatsApp sin ese campo poblado) — nunca se infiere ni se cuenta a mano.
     */
    whatsappMessageQuantity: number | null;
    /**
     * Canal real de la conversación, derivado de
     * `metadata.conversation_initiation_source` (nunca un literal fijo —
     * ver src/types/lead-enums.ts). Antes de esto, `process_call_completed`
     * escribía `'voice'` a fuego para TODO lead, incluidas conversaciones de
     * WhatsApp — verificado contra un caso real de producción
     * (conv_6201kzkmwnd8e658dn4c8fqg1c0d) que quedó con channel='voice'
     * estando mal.
     */
    channel: LeadChannel;
    /**
     * Tokens de LLM por modelo (`irreversible_generation`, ver arriba).
     * Arreglo vacío cuando el payload no trae
     * `metadata.charging.llm_usage.irreversible_generation.model_usage` —
     * nunca se inventa un consumo. El resolver de metering (usage-registration.ts)
     * es responsable de advertir con el conversation_id cuando esto pasa.
     */
    llmTokenUsage: LlmModelTokenUsage[];
}

/**
 * Claves de `analysis.data_collection_results` configuradas en el agente de
 * ElevenLabs (Dashboard → Agent → Analysis → Data Collection). No son fijas
 * por la API de ElevenLabs: son específicas de este agente. La fuente de
 * verdad es el agente configurado en el dashboard de ElevenLabs, no este
 * archivo — si alguien renombra un campo de Data Collection allá, este
 * diccionario se desincroniza en silencio (los 4 campos afectados se
 * descartan sin error, ver docs/tasks/elevenlabs-data-collection-key-mismatch.md)
 * y hay que volver a sincronizarlo aquí, nunca al revés.
 *
 * `fullName`/`contactPhone`/`email`/`bookedAppointment` verificados contra
 * una conversación real (captura de Analysis → Data Collection). El resto
 * (`businessName`, `businessSector`, `temperature`, `needsFollowup`,
 * `followupNotes`, `callVolume`) son especulativos: el agente aún no los
 * captura, no hay evidencia de qué nombre tendrían si se configuraran.
 */
const DATA_COLLECTION_KEYS = {
    fullName: 'nombre_completo_prospecto',
    contactPhone: 'telefono_contacto_prospecto',
    email: 'correo_electronico_prospecto',
    inquiryReason: 'motivo_consulta',
    bookedAppointment: 'cita_programada',
    businessName: 'nombre_negocio',
    businessSector: 'giro_negocio',
    temperature: 'temperatura',
    needsFollowup: 'requiere_seguimiento',
    followupNotes: 'notas_seguimiento',
    callVolume: 'volumen_llamadas',
} as const;

type DataCollectionResults = Record<string, z.infer<typeof dataCollectionEntrySchema>>;

/**
 * Extrae el valor crudo de una entrada de `data_collection_results`. Las
 * entradas pueden venir como valor escalar o como objeto `{ value, ... }`.
 * Nunca infiere ni completa: si no hay valor, devuelve `null`.
 */
function extractRawValue(results: DataCollectionResults | undefined, key: string): string | number | boolean | null {
    if (!results) return null;
    const entry = results[key];
    if (entry === undefined || entry === null) return null;
    if (typeof entry === 'object') {
        const value = entry.value;
        return value === undefined ? null : value;
    }
    return entry;
}

function extractString(results: DataCollectionResults | undefined, key: string): string | null {
    const raw = extractRawValue(results, key);
    if (raw === null) return null;
    const str = String(raw).trim();
    return str === '' ? null : str;
}

function extractBoolean(results: DataCollectionResults | undefined, key: string): boolean {
    const raw = extractRawValue(results, key);
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') return ['true', 'verdadero', 'sí', 'si'].includes(raw.trim().toLowerCase());
    return false;
}

/**
 * `leads.temperature` tiene un CHECK constraint (src/types/lead-enums.ts).
 * Un valor que no coincida exactamente se trata como ausente, nunca se
 * fuerza a uno de los válidos: insertarlo tal cual haría fallar el INSERT
 * (y con pg-boss, reintentar indefinidamente sin nunca tener éxito).
 */
function extractTemperature(results: DataCollectionResults | undefined, key: string): LeadTemperature | null {
    const raw = extractString(results, key);
    if (raw === null) return null;
    const normalized = raw.toLowerCase();
    return isLeadTemperature(normalized) ? normalized : null;
}

/**
 * Deriva `leads.channel` de `metadata.conversation_initiation_source`
 * (enum documentado por ElevenLabs, ver el comentario del schema arriba).
 * Los valores de telefonía (`sip_trunk`, `twilio`, `exotel`, `genesys`,
 * `audiocodes`) y los SDK embebidos en apps/web (`*_sdk`, `widget`) cuentan
 * como `voice` salvo que `isTextChannel` diga lo contrario — el mismo SDK
 * puede servir una conversación de voz o de solo texto, `text_only` es la
 * señal real, no el SDK en sí.
 */
function deriveChannel(conversationInitiationSource: string | undefined, isTextChannel: boolean): LeadChannel {
    if (conversationInitiationSource === 'whatsapp') return LEAD_CHANNELS.WHATSAPP;
    if (conversationInitiationSource === 'twilio_sms') return LEAD_CHANNELS.SMS;
    if (isTextChannel) return LEAD_CHANNELS.WEB;
    return LEAD_CHANNELS.VOICE;
}

type ModelUsageMap = Record<
    string,
    {
        input?: { tokens?: number };
        output_total?: { tokens?: number };
    }
>;

/**
 * Extrae tokens de entrada/salida por modelo de
 * `metadata.charging.llm_usage.irreversible_generation.model_usage`. Nunca
 * infiere: un modelo sin `input`/`output_total` en el payload queda en 0
 * tokens para ese lado, no se omite el modelo completo (podría tener
 * tokens del otro lado).
 */
function extractLlmTokenUsage(modelUsage: ModelUsageMap | undefined): LlmModelTokenUsage[] {
    if (!modelUsage) return [];
    return Object.entries(modelUsage).map(([model, usage]) => ({
        model,
        inputTokens: usage.input?.tokens ?? 0,
        outputTokens: usage.output_total?.tokens ?? 0,
    }));
}

/**
 * Mapea el payload crudo (ya parseado como JSON) del webhook de post-llamada
 * de ElevenLabs a los campos que consume `process_call_completed`.
 *
 * Devuelve `null` cuando el evento no es `post_call_transcription` (p. ej.
 * `post_call_audio` o fallos de inicio de llamada): esos tipos quedan fuera
 * del alcance de la Fase 2 y no deben procesarse como lead.
 *
 * Regla de honestidad de datos: ningún campo se infiere del transcript por
 * heurística/regex. Solo se leen los campos estructurados que ElevenLabs
 * entrega en `data_collection_results` y `metadata`.
 */
export function mapElevenLabsPayload(rawPayload: unknown): MappedCallData | null {
    const parsed = elevenLabsWebhookSchema.safeParse(rawPayload);
    if (!parsed.success) {
        throw new Error(`Payload de ElevenLabs con esquema inesperado: ${parsed.error.message}`);
    }

    const { type, data, event_timestamp } = parsed.data;
    if (type !== 'post_call_transcription') {
        return null;
    }

    const results = data.analysis?.data_collection_results;

    const transcript = (data.transcript || [])
        .map((turn) => `${turn.role === 'user' ? 'Cliente' : 'Agente'}: ${turn.message || ''}`)
        .join('\n');

    // El número de telefonía (SIP/PSTN) es la fuente autoritativa del contacto
    // cuando existe; whatsapp_user_id es la fuente autoritativa en canal
    // WhatsApp (no hay tramo telefónico ahí, phone_call es null); el número
    // dictado por voz (telefono_contacto_prospecto) es el último respaldo,
    // para canales sin ninguno de los dos (p. ej. widget web).
    const telephonyNumber = data.metadata?.phone_call?.external_number || null;
    const whatsappUserId = data.metadata?.whatsapp?.whatsapp_user_id || null;
    const contactPhoneRaw = extractString(results, DATA_COLLECTION_KEYS.contactPhone);
    const phoneToNormalize = telephonyNumber || whatsappUserId || contactPhoneRaw;
    const normalizedPhone = phoneToNormalize ? normalizePhoneE164(phoneToNormalize) : null;

    const startUnixSecs = data.metadata?.start_time_unix_secs ?? event_timestamp ?? null;
    const occurredAt = startUnixSecs !== null ? new Date(startUnixSecs * 1000) : new Date();

    const isTextChannel = data.metadata?.conversation_initiation_source === 'whatsapp' || data.metadata?.text_only === true;
    const whatsappMessageQuantity = data.metadata?.platform_usage?.category_usage?.text_message?.quantity ?? null;
    const channel = deriveChannel(data.metadata?.conversation_initiation_source, isTextChannel);
    const llmTokenUsage = extractLlmTokenUsage(data.metadata?.charging?.llm_usage?.irreversible_generation?.model_usage);

    return {
        conversationId: data.conversation_id,
        agentId: data.agent_id,
        providerCallId: data.conversation_id,
        transcript,
        summary: data.analysis?.transcript_summary || null,
        durationSeconds: data.metadata?.call_duration_secs ?? 0,
        callerPhoneE164: normalizedPhone?.success ? normalizedPhone.phoneE164 : null,
        contactPhoneRaw,
        fullName: extractString(results, DATA_COLLECTION_KEYS.fullName),
        email: extractString(results, DATA_COLLECTION_KEYS.email),
        businessName: extractString(results, DATA_COLLECTION_KEYS.businessName),
        businessSector: extractString(results, DATA_COLLECTION_KEYS.businessSector),
        inquiryReason: extractString(results, DATA_COLLECTION_KEYS.inquiryReason),
        temperature: extractTemperature(results, DATA_COLLECTION_KEYS.temperature),
        bookedAppointment: extractBoolean(results, DATA_COLLECTION_KEYS.bookedAppointment),
        needsFollowup: extractBoolean(results, DATA_COLLECTION_KEYS.needsFollowup),
        followupNotes: extractString(results, DATA_COLLECTION_KEYS.followupNotes),
        callVolume: extractString(results, DATA_COLLECTION_KEYS.callVolume),
        occurredAt,
        hasPhoneCallLeg: Boolean(data.metadata?.phone_call),
        isTextChannel,
        whatsappMessageQuantity,
        channel,
        llmTokenUsage,
    };
}
