/**
 * Valores permitidos por el CHECK constraint de `webhook_events.provider`.
 * Única fuente de verdad: ningún literal de este campo debe escribirse en
 * otro lugar del código. Verificado por inserción directa contra la base
 * real — ver __tests__/webhook-provider.test.ts.
 *
 * Distinto (y más largo) que USAGE_EVENT_PROVIDERS: `cal` es válido aquí
 * pero NO para usage_events.provider — verificado empíricamente.
 */
export const WEBHOOK_EVENT_PROVIDERS = {
    ELEVENLABS: 'elevenlabs',
    TELNYX: 'telnyx',
    META: 'meta',
    CAL: 'cal',
} as const;

export type WebhookEventProvider = (typeof WEBHOOK_EVENT_PROVIDERS)[keyof typeof WEBHOOK_EVENT_PROVIDERS];

export const ALL_WEBHOOK_EVENT_PROVIDERS: readonly WebhookEventProvider[] = Object.values(WEBHOOK_EVENT_PROVIDERS);

export function isWebhookEventProvider(value: string): value is WebhookEventProvider {
    return (ALL_WEBHOOK_EVENT_PROVIDERS as readonly string[]).includes(value);
}
