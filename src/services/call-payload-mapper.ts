import { z } from 'zod';
import { normalizePhoneE164 } from './phone-normalization.js';
import { isLeadTemperature, type LeadTemperature } from '../types/lead-enums.js';

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
                phone_call: z
                    .object({
                        external_number: z.string().optional(),
                        agent_number: z.string().optional(),
                        direction: z.string().optional(),
                    })
                    .passthrough()
                    .optional(),
            })
            .passthrough()
            .optional(),
    }),
});

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
}

/**
 * Claves de `analysis.data_collection_results` configuradas en el agente de
 * ElevenLabs (Dashboard → Agent → Analysis → Data Collection). No son fijas
 * por la API de ElevenLabs: son específicas de este agente.
 */
const DATA_COLLECTION_KEYS = {
    fullName: 'nombre_completo',
    contactPhone: 'telefono_contacto',
    email: 'email',
    inquiryReason: 'motivo_consulta',
    bookedAppointment: 'agendo_cita',
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
    // cuando existe; el número dictado por voz (telefono_contacto) es un
    // respaldo para canales sin telefonía (p. ej. widget web).
    const telephonyNumber = data.metadata?.phone_call?.external_number || null;
    const contactPhoneRaw = extractString(results, DATA_COLLECTION_KEYS.contactPhone);
    const phoneToNormalize = telephonyNumber || contactPhoneRaw;
    const normalizedPhone = phoneToNormalize ? normalizePhoneE164(phoneToNormalize) : null;

    const startUnixSecs = data.metadata?.start_time_unix_secs ?? event_timestamp ?? null;
    const occurredAt = startUnixSecs !== null ? new Date(startUnixSecs * 1000) : new Date();

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
    };
}
