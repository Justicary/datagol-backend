/**
 * Valores canónicos del dominio de entitlements (organization_features / plans).
 *
 * FEATURE_CATEGORIES: valores permitidos por el CHECK constraint
 * `features_category_check` sobre `features.category`. Verificado por
 * inserción directa — ver __tests__/feature-taxonomy.test.ts.
 *
 * PLAN_KEYS: `plans.key` NO tiene CHECK constraint (es una PK de texto
 * libre) — no hay nada que un INSERT arbitrario pueda "rechazar". Lo que se
 * verifica en su lugar es que cada clave aquí listada exista de verdad como
 * fila en `plans`, para que un typo o un plan retirado no pase inadvertido
 * en el literal `'starter'` usado como fallback en el código.
 */
export const FEATURE_CATEGORIES = {
    VOZ: 'voz',
    MENSAJERIA: 'mensajeria',
    WEB: 'web',
    OPERACION: 'operacion',
    PLATAFORMA: 'plataforma',
} as const;

export type FeatureCategory = (typeof FEATURE_CATEGORIES)[keyof typeof FEATURE_CATEGORIES];

export const ALL_FEATURE_CATEGORIES: readonly FeatureCategory[] = Object.values(FEATURE_CATEGORIES);

export const PLAN_KEYS = {
    STARTER: 'starter',
    PRO: 'pro',
    ELITE: 'elite',
    ENTERPRISE: 'enterprise',
} as const;

export type PlanKey = (typeof PLAN_KEYS)[keyof typeof PLAN_KEYS];

export const ALL_PLAN_KEYS: readonly PlanKey[] = Object.values(PLAN_KEYS);

/**
 * `features.key` tampoco tiene CHECK constraint (PK de texto libre, igual
 * que `plans.key`) — lo que se verifica es que cada clave aquí listada
 * exista de verdad como fila en `features`, no que la base la "acepte".
 * Solo se listan las claves que el código realmente consulta (Fase 4:
 * notify-hot-lead y send-call-summary las verifican antes de enviar,
 * AGENTS.md §16 — "verificar la feature antes de ejecutar el efecto").
 */
export const FEATURE_KEYS = {
    HOT_LEAD_ALERTS: 'hot_lead_alerts',
    EMAIL_SUMMARIES: 'email_summaries',
} as const;

export type FeatureKey = (typeof FEATURE_KEYS)[keyof typeof FEATURE_KEYS];

export const ALL_FEATURE_KEYS: readonly FeatureKey[] = Object.values(FEATURE_KEYS);
