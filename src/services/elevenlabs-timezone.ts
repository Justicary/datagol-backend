const IANA_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

function pickString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Extrae una zona horaria IANA del payload crudo del webhook post-llamada de
 * ElevenLabs, si viene incluida. Función pura y defensiva: nunca lanza,
 * siempre devuelve `null` ante cualquier forma inesperada del payload.
 *
 * Estado verificado (2026-08-17): el esquema real y ya validado de este
 * webhook (`services/call-payload-mapper.ts`, contrastado contra payloads de
 * producción reales) NO incluye ningún campo de timezone bajo `data.metadata`
 * hoy. `docs/tasks/reportes-semanales.md` (A.1) afirma que sí viene, pero no
 * se pudo confirmar contra ningún payload real ni contra la documentación
 * oficial. Esta función queda lista y es inofensiva si el campo nunca llega
 * (siempre `null`, nunca bloquea el job que la llama) — sirve tanto si
 * ElevenLabs empieza a mandarlo en `data.metadata.timezone`, como si en
 * realidad viaja en `conversation_initiation_client_data.dynamic_variables`
 * (la variable de sistema documentada `system__time_zone`), sin necesidad de
 * tocar el llamador. Mientras tanto, la vía confiable para fijar la zona
 * horaria es el endpoint manual `PATCH /api/organizations/:id/business-info`.
 */
export function extractTimezoneFromElevenLabsPayload(payload: unknown): string | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const root = payload as Record<string, unknown>;
    const data = root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : root;

    const candidates: unknown[] = [];

    const metadata = data.metadata && typeof data.metadata === 'object' ? (data.metadata as Record<string, unknown>) : null;
    if (metadata) {
        candidates.push(metadata.timezone);
        candidates.push(metadata.time_zone);
    }

    const initiationData =
        data.conversation_initiation_client_data && typeof data.conversation_initiation_client_data === 'object'
            ? (data.conversation_initiation_client_data as Record<string, unknown>)
            : null;
    const dynamicVariables =
        initiationData?.dynamic_variables && typeof initiationData.dynamic_variables === 'object'
            ? (initiationData.dynamic_variables as Record<string, unknown>)
            : null;
    if (dynamicVariables) {
        candidates.push(dynamicVariables.system__time_zone);
        candidates.push(dynamicVariables.timezone);
    }

    for (const candidate of candidates) {
        const value = pickString(candidate);
        if (value && IANA_TIMEZONES.has(value)) {
            return value;
        }
    }

    return null;
}
