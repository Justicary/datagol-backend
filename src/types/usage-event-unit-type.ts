/**
 * `unit_type` de `usage_events`/`provider_rates` es texto libre en el
 * esquema (sin CHECK constraint) — pero el código nunca debe escribir un
 * literal fuera de esta lista. Única fuente de verdad para los `unit_type`
 * que el job `process-call-completed` (Fase 3.2, ver
 * docs/tasks/backend-implementation.md) sabe registrar.
 *
 * `sip_inbound_local_mx` es el único unit_type de telefonía que este job usa
 * hoy: `call_logs.call_type` está fijo en 'inbound' en
 * `db/migrations/03_process_call_completed.sql` — el sistema aún no procesa
 * llamadas salientes (jobs/outbound, ver AGENTS.md §8, no implementado).
 * `sip_outbound_fixed_mx` / `sip_outbound_mobile_mx` existen en
 * `provider_rates` para cuando ese job exista, no se usan todavía.
 */
export const USAGE_EVENT_UNIT_TYPES = {
    AGENT_MINUTE: 'agent_minute',
    SIP_INBOUND_LOCAL_MX: 'sip_inbound_local_mx',
    WA_MESSAGE: 'wa_message',
} as const;

/**
 * Tokens de LLM: `unit_type` no puede ser una lista fija — el modelo (clave
 * de `metadata.charging.llm_usage.irreversible_generation.model_usage` en el
 * payload de ElevenLabs, ej. `gemini-2.5-flash`, `gpt-4o`) cambia según qué
 * modelo tenga configurado el agente, y ElevenLabs puede cambiarlo sin avisar.
 * Estas funciones son la única fuente de verdad para construir ese
 * `unit_type` dinámico — nunca interpolar el string a mano en otro lugar.
 * Input y output se miden por separado porque tienen tarifas por token
 * distintas (el output siempre es más caro que el input en los payloads
 * reales verificados).
 */
export function llmInputTokenUnitType(model: string): string {
    return `llm_input_token_${model}`;
}

export function llmOutputTokenUnitType(model: string): string {
    return `llm_output_token_${model}`;
}

export type UsageEventUnitType = (typeof USAGE_EVENT_UNIT_TYPES)[keyof typeof USAGE_EVENT_UNIT_TYPES];

export const ALL_USAGE_EVENT_UNIT_TYPES: readonly UsageEventUnitType[] = Object.values(USAGE_EVENT_UNIT_TYPES);

export function isUsageEventUnitType(value: string): value is UsageEventUnitType {
    return (ALL_USAGE_EVENT_UNIT_TYPES as readonly string[]).includes(value);
}
