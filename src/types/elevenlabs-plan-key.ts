/**
 * Claves de `elevenlabs_plans.key` (`db/migrations/56_catalogo_productos.sql`
 * BLOQUE 1). La columna es una PK de texto libre sin CHECK constraint — lo
 * que se verifica es que cada clave aquí listada exista de verdad como fila
 * sembrada, mismo criterio que `PLAN_KEYS` en types/feature-taxonomy.ts.
 *
 * Verificado por lectura directa contra la base real — ver
 * __tests__/catalog-enums.test.ts.
 */
export const ELEVENLABS_PLAN_KEYS = {
    CREATOR: 'creator',
    PRO: 'pro',
    SCALE: 'scale',
    BUSINESS: 'business',
} as const;

export type ElevenLabsPlanKey = (typeof ELEVENLABS_PLAN_KEYS)[keyof typeof ELEVENLABS_PLAN_KEYS];

export const ALL_ELEVENLABS_PLAN_KEYS: readonly ElevenLabsPlanKey[] = Object.values(ELEVENLABS_PLAN_KEYS);

export function isElevenLabsPlanKey(value: string): value is ElevenLabsPlanKey {
    return (ALL_ELEVENLABS_PLAN_KEYS as readonly string[]).includes(value);
}
