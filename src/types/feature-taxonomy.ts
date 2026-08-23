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
    WHATSAPP: 'whatsapp',
    AUTOMATIC_THANK_YOU: 'automatic_thank_you',
    // Reportes semanales BYOK (docs/tasks/reportes-semanales.md, Fase B).
    // requires_provider es NULL para ambas — la llave es del cliente, no de
    // un proveedor que Datagol administre — así que la guarda de credencial
    // vive aparte en llm-config-service.ts (isLlmConfigValidated), invocada
    // desde entitlements.ts junto al guard genérico de checkProviderCredentials.
    WEEKLY_PLANNING_REPORT: 'weekly_planning_report',
    WEEKLY_EXECUTIVE_REPORT: 'weekly_executive_report',
    // Análisis de competencia (Fase C, mismo doc de tarea) — sección extra
    // del reporte ejecutivo. Mismo motivo que las dos anteriores:
    // requires_provider NULL, guarda de isLlmConfigValidated en entitlements.ts.
    COMPETITOR_ANALYSIS: 'competitor_analysis',
    // Reportes en lenguaje natural (docs/tasks/reportes-lenguaje-natural.md).
    // requires_provider es NULL (BYOK de LLM), exige isLlmConfigValidated.
    NATURAL_LANGUAGE_REPORTS: 'natural_language_reports',
    // Integración de correo nativa (docs/tasks/native-mail-integration.md).
    // requires_provider es NULL: las credenciales IMAP/SMTP las aporta el
    // cliente, no un proveedor que Datagol administre.
    EMAIL_INTEGRATION: 'email_integration',
    // Catálogo de productos con sugerencia de precio/disponibilidad vía RAG
    // (docs/tasks/catalogo-productos-grupos-cred.md). Planes elite/enterprise
    // (db/migrations/56_catalogo_productos.sql BLOQUE 10). requires_provider
    // es NULL: la KB usada es la nativa de ElevenLabs, ya cubierta por
    // elevenlabs_api_key, no un proveedor propio de este feature.
    PRODUCT_RAG: 'product_rag',
} as const;

export type FeatureKey = (typeof FEATURE_KEYS)[keyof typeof FEATURE_KEYS];

export const ALL_FEATURE_KEYS: readonly FeatureKey[] = Object.values(FEATURE_KEYS);
