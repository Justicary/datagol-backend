/**
 * Valores permitidos por el CHECK constraint `permission_audit_log_action_check`
 * (db/migrations/45_RBAC_permisos.sql, BLOQUE 3). Única fuente de verdad:
 * ningún literal de `action` debe escribirse en otro lugar del código.
 *
 * Verificado por inserción directa contra la base real — ver
 * __tests__/permission-audit-actions.test.ts.
 */
export const PERMISSION_AUDIT_ACTIONS = {
    GRANTED: 'granted',
    REVOKED: 'revoked',
    EXPIRED: 'expired',
    ROLE_CHANGED: 'role_changed',
    USER_INVITED: 'user_invited',
    USER_REMOVED: 'user_removed',
} as const;

export type PermissionAuditAction = (typeof PERMISSION_AUDIT_ACTIONS)[keyof typeof PERMISSION_AUDIT_ACTIONS];

export const ALL_PERMISSION_AUDIT_ACTIONS: readonly PermissionAuditAction[] = Object.values(PERMISSION_AUDIT_ACTIONS);

export function isPermissionAuditAction(value: string): value is PermissionAuditAction {
    return (ALL_PERMISSION_AUDIT_ACTIONS as readonly string[]).includes(value);
}
