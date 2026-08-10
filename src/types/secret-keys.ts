/**
 * Claves permitidas por el CHECK constraint de `organization_secrets.secret_key`.
 * Única fuente de verdad: ningún literal de clave de secreto debe escribirse
 * en otro lugar del código. Si la base de datos amplía el CHECK constraint,
 * actualizar únicamente este módulo.
 *
 * Verificado por inserción directa contra la base real (no asumido) — ver
 * __tests__/secret-keys.test.ts, que falla si esta lista se desincroniza del
 * constraint.
 */
export const SECRET_KEYS = {
    ELEVENLABS_API_KEY: 'elevenlabs_api_key',
    TELNYX_API_KEY: 'telnyx_api_key',
    WHATSAPP_ACCESS_TOKEN: 'whatsapp_access_token',
    CAL_API_KEY: 'cal_api_key',
    META_APP_SECRET: 'meta_app_secret',
    WEBHOOK_SIGNING_SECRET: 'webhook_signing_secret',
    TOOL_WEBHOOK_SECRET: 'tool_webhook_secret',
    GOOGLE_MAPS_KEY: 'google_maps_key',
} as const;

export type SecretKey = (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS];

export const ALL_SECRET_KEYS: readonly SecretKey[] = Object.values(SECRET_KEYS);

export function isSecretKey(value: string): value is SecretKey {
    return (ALL_SECRET_KEYS as readonly string[]).includes(value);
}
