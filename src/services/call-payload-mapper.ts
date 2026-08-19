import { z } from 'zod';
import { normalizePhoneE164 } from './phone-normalization.js';
import { isLeadTemperature, type LeadTemperature, LEAD_CHANNELS, type LeadChannel } from '../types/lead-enums.js';
import { isLeadSource, LEAD_SOURCES, type LeadSource } from '../types/lead-source.js';

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

/**
 * Un turno individual del transcript, con el mismo mapeo `role==='user' →
 * cliente` que la versión aplanada (`transcript: string`). Se usa para
 * respaldar `whatsapp_messages` con mensajes individuales en vez del párrafo
 * único de `transcript` — ver jobs/process-call-completed.ts.
 */
export interface TranscriptTurn {
    role: 'user' | 'agent';
    message: string;
}

export interface MappedCallData {
    conversationId: string;
    agentId: string;
    providerCallId: string;
    transcript: string;
    /**
     * Mismos turnos que `transcript`, sin aplanar y sin los turnos vacíos
     * (`message` null/vacío) — ElevenLabs no entrega `wa_message_id` por
     * turno, así que no hay forma de deduplicar un turno sin contenido.
     */
    transcriptTurns: TranscriptTurn[];
    summary: string | null;
    durationSeconds: number;
    callerPhoneE164: string | null;
    contactPhoneRaw: string | null;
    fullName: string | null;
    email: string | null;
    businessName: string | null;
    businessSector: string | null;
    inquiryReason: string | null;
    /**
     * Dirección de servicio del prospecto, tal como la dicta (sin
     * geocodificar). `address` es la calle y número; `city`/`state`/`zip`
     * son los campos separados que el agente captura en Data Collection
     * (`ciudad_prospecto`/`estado_prospecto`/`cp_prospecto`). La
     * geocodificación a lat/lng ocurre después, en
     * jobs/process-call-completed.ts vía services/geocoding.ts — este
     * mapper solo lee lo que ElevenLabs entrega.
     */
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    temperature: LeadTemperature | null;
    /** Plan o paquete por el que mostró interés el prospecto. */
    planOfInterest: string | null;
    /** Volumen estimado de mensajes mencionado por el prospecto. */
    messageVolume: string | null;
    /**
     * Cómo se enteró el prospecto del negocio (D.1, docs/tasks/asistencia-valor
     * de cierre.md) — `null` si el campo `origen_prospecto` (o `como_se_entero`) no vino en absoluto
     * (agente sin ese campo de Data Collection todavía); `'desconocido'` si
     * vino pero el texto no encaja en ninguno de los 9 valores del
     * constraint (nunca se fuerza a la categoría más cercana).
     */
    source: LeadSource | null;
    /** Texto crudo tal como lo dijo el prospecto/lo capturó el LLM, sin normalizar. */
    sourceDetail: string | null;
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
 * ElevenLabs (Dashboard → Agent → Analysis → Data Collection).
 * Sincronizadas con los 18 campos reales del agente en producción.
 */
const DATA_COLLECTION_KEYS = {
    fullName: 'nombre_completo_prospecto',
    contactPhone: 'telefono_contacto_prospecto',
    email: 'correo_electronico_prospecto',
    inquiryReason: 'motivo_consulta',
    bookedAppointment: 'cita_programada',
    temperature: 'temperatura',
    needsFollowup: 'requiere_seguimiento',
    planOfInterest: 'plan_de_interes',
    businessName: 'nombre_negocio',
    businessSector: 'giro_negocio',
    callVolume: 'volumen_llamadas',
    followupNotes: 'notas_seguimiento',
    address: 'direccion_prospecto',
    city: 'ciudad_prospecto',
    state: 'estado_prospecto',
    zip: 'cp_prospecto',
    messageVolume: 'volumen_mensajes',
    origenProspecto: 'origen_prospecto',
    // Compatibilidad retroactiva con nombre previo
    comoSeEntero: 'como_se_entero',
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
 * Mapeo de los valores del enum de `origen_prospecto` de ElevenLabs
 * ('referido', 'web', 'facebook', 'instagram', 'llamada', 'tiktok', 'otro')
 * hacia las categorías autorizadas por el CHECK constraint de `leads.source`.
 */
const SOURCE_ENUM_MAP: Record<string, LeadSource> = {
    referido: LEAD_SOURCES.REFERIDO,
    web: LEAD_SOURCES.SITIO_WEB,
    facebook: LEAD_SOURCES.REDES_SOCIALES,
    instagram: LEAD_SOURCES.REDES_SOCIALES,
    tiktok: LEAD_SOURCES.REDES_SOCIALES,
    llamada: LEAD_SOURCES.OTRO,
    otro: LEAD_SOURCES.OTRO,
    // Coincidencias exactas con los 9 valores del constraint de BD
    anuncio_pagado: LEAD_SOURCES.ANUNCIO_PAGADO,
    busqueda_google: LEAD_SOURCES.BUSQUEDA_GOOGLE,
    redes_sociales: LEAD_SOURCES.REDES_SOCIALES,
    sitio_web: LEAD_SOURCES.SITIO_WEB,
    letrero_fisico: LEAD_SOURCES.LETRERO_FISICO,
    directorio: LEAD_SOURCES.DIRECTORIO,
    desconocido: LEAD_SOURCES.DESCONOCIDO,
};

/**
 * `leads.source` tiene un CHECK constraint de 9 valores
 * (src/types/lead-source.ts). Mapea el valor de ElevenLabs (enum o texto libre)
 * al valor canónico. Si vino un texto pero no encaja, se mapea a 'desconocido'.
 * Si ninguna de las claves candidatas vino, devuelve null.
 */
function extractLeadSource(results: DataCollectionResults | undefined, keys: readonly string[]): LeadSource | null {
    for (const key of keys) {
        const raw = extractString(results, key);
        if (raw !== null) {
            const normalized = raw.toLowerCase().trim();
            if (SOURCE_ENUM_MAP[normalized]) {
                return SOURCE_ENUM_MAP[normalized];
            }
            return isLeadSource(normalized) ? normalized : LEAD_SOURCES.DESCONOCIDO;
        }
    }
    return null;
}

function extractLeadSourceDetail(results: DataCollectionResults | undefined, keys: readonly string[]): string | null {
    for (const key of keys) {
        const raw = extractString(results, key);
        if (raw !== null) return raw;
    }
    return null;
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

    const transcriptTurns: TranscriptTurn[] = (data.transcript || [])
        .filter((turn) => turn.message && turn.message.trim() !== '')
        .map((turn) => ({
            role: turn.role === 'user' ? 'user' : 'agent',
            message: turn.message as string,
        }));

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
        transcriptTurns,
        summary: data.analysis?.transcript_summary || null,
        durationSeconds: data.metadata?.call_duration_secs ?? 0,
        callerPhoneE164: normalizedPhone?.success ? normalizedPhone.phoneE164 : null,
        contactPhoneRaw,
        fullName: extractString(results, DATA_COLLECTION_KEYS.fullName),
        email: extractString(results, DATA_COLLECTION_KEYS.email),
        businessName: extractString(results, DATA_COLLECTION_KEYS.businessName),
        businessSector: extractString(results, DATA_COLLECTION_KEYS.businessSector),
        inquiryReason: extractString(results, DATA_COLLECTION_KEYS.inquiryReason),
        address: extractString(results, DATA_COLLECTION_KEYS.address),
        city: extractString(results, DATA_COLLECTION_KEYS.city),
        state: extractString(results, DATA_COLLECTION_KEYS.state),
        zip: extractString(results, DATA_COLLECTION_KEYS.zip),
        temperature: extractTemperature(results, DATA_COLLECTION_KEYS.temperature),
        planOfInterest: extractString(results, DATA_COLLECTION_KEYS.planOfInterest),
        messageVolume: extractString(results, DATA_COLLECTION_KEYS.messageVolume),
        source: extractLeadSource(results, [DATA_COLLECTION_KEYS.origenProspecto, DATA_COLLECTION_KEYS.comoSeEntero]),
        sourceDetail: extractLeadSourceDetail(results, [DATA_COLLECTION_KEYS.origenProspecto, DATA_COLLECTION_KEYS.comoSeEntero]),
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
