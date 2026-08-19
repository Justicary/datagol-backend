/**
 * Catálogo de `permissions.key` y `permissions.category`
 * (db/migrations/45_RBAC_permisos.sql, BLOQUE 1). Única fuente de verdad:
 * ningún literal de clave o categoría de permiso debe escribirse en otro
 * lugar del código.
 *
 * Verificado por inserción directa contra la base real — ver
 * __tests__/permission-keys.test.ts.
 */
export const PERMISSION_CATEGORIES = {
    DATOS: 'datos',
    OPERACION: 'operacion',
    FINANZAS: 'finanzas',
    CONFIGURACION: 'configuracion',
    USUARIOS: 'usuarios',
} as const;

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[keyof typeof PERMISSION_CATEGORIES];

export const ALL_PERMISSION_CATEGORIES: readonly PermissionCategory[] = Object.values(PERMISSION_CATEGORIES);

export const PERMISSION_KEYS = {
    VIEW_CONTACTS: 'view_contacts',
    VIEW_CONVERSATIONS: 'view_conversations',
    VIEW_TRANSCRIPTS: 'view_transcripts',
    EDIT_CONTACTS: 'edit_contacts',
    MANAGE_PIPELINE: 'manage_pipeline',
    CLOSE_DEALS: 'close_deals',
    VIEW_COSTS: 'view_costs',
    VIEW_REVENUE: 'view_revenue',
    USE_NL_REPORTS: 'use_nl_reports',
    CONFIGURE_AGENT: 'configure_agent',
    EXPORT_DATA: 'export_data',
    MANAGE_USERS: 'manage_users',
    MANAGE_CREDENTIALS: 'manage_credentials',
    CHANGE_PLAN: 'change_plan',
    ERASE_CONTACT_DATA: 'erase_contact_data',
} as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[keyof typeof PERMISSION_KEYS];

export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = Object.values(PERMISSION_KEYS);

export function isPermissionKey(value: string): value is PermissionKey {
    return (ALL_PERMISSION_KEYS as readonly string[]).includes(value);
}

/**
 * Permisos con `is_sensitive = true` en el catálogo — otorgarlos a un rol
 * bajo abre una vía de escalamiento. `routes/admin/permissions.ts` (FASE D)
 * exige confirmación explícita adicional en el payload antes de conceder
 * uno de estos vía override.
 */
export const SENSITIVE_PERMISSION_KEYS: ReadonlySet<PermissionKey> = new Set([
    PERMISSION_KEYS.VIEW_TRANSCRIPTS,
    PERMISSION_KEYS.VIEW_COSTS,
    PERMISSION_KEYS.VIEW_REVENUE,
    PERMISSION_KEYS.USE_NL_REPORTS,
    PERMISSION_KEYS.CONFIGURE_AGENT,
    PERMISSION_KEYS.EXPORT_DATA,
    PERMISSION_KEYS.MANAGE_USERS,
    PERMISSION_KEYS.MANAGE_CREDENTIALS,
    PERMISSION_KEYS.CHANGE_PLAN,
    PERMISSION_KEYS.ERASE_CONTACT_DATA,
]);

export function isSensitivePermission(key: string): boolean {
    return SENSITIVE_PERMISSION_KEYS.has(key as PermissionKey);
}
