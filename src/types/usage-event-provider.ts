/**
 * Valores permitidos por el CHECK constraint de `usage_events.provider`.
 * Única fuente de verdad: ningún literal de este campo debe escribirse en
 * otro lugar del código. Verificado por inserción directa contra la base
 * real — ver __tests__/usage-event-provider.test.ts.
 *
 * Distinto (y más corto) que WEBHOOK_EVENT_PROVIDERS: `cal` es válido para
 * webhook_events.provider pero NO para usage_events.provider — verificado
 * empíricamente, no asumido por analogía entre tablas.
 *
 * Usado por el registro de consumo de la Fase 3 (metering) —
 * docs/tasks/backend-implementation.md §3.2 — que aún no está implementada.
 */
export const USAGE_EVENT_PROVIDERS = {
    ELEVENLABS: 'elevenlabs',
    TELNYX: 'telnyx',
    META: 'meta',
} as const;

export type UsageEventProvider = (typeof USAGE_EVENT_PROVIDERS)[keyof typeof USAGE_EVENT_PROVIDERS];

export const ALL_USAGE_EVENT_PROVIDERS: readonly UsageEventProvider[] = Object.values(USAGE_EVENT_PROVIDERS);

export function isUsageEventProvider(value: string): value is UsageEventProvider {
    return (ALL_USAGE_EVENT_PROVIDERS as readonly string[]).includes(value);
}
