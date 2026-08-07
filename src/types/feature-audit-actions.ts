/**
 * Valores permitidos por el CHECK constraint `feature_audit_log_action_check`.
 * Única fuente de verdad: ningún literal de `action` debe escribirse en otro
 * lugar del código. Verificado por inserción directa contra la base real —
 * ver __tests__/feature-audit-actions.test.ts.
 */
export const FEATURE_AUDIT_ACTIONS = {
    ENABLED: 'enabled',
    DISABLED: 'disabled',
    PLAN_CHANGED: 'plan_changed',
    SUSPENDED: 'suspended',
    REACTIVATED: 'reactivated',
} as const;

export type FeatureAuditAction = (typeof FEATURE_AUDIT_ACTIONS)[keyof typeof FEATURE_AUDIT_ACTIONS];

export const ALL_FEATURE_AUDIT_ACTIONS: readonly FeatureAuditAction[] = Object.values(FEATURE_AUDIT_ACTIONS);

export function isFeatureAuditAction(value: string): value is FeatureAuditAction {
    return (ALL_FEATURE_AUDIT_ACTIONS as readonly string[]).includes(value);
}
