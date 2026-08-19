import { describe, it, expect } from 'vitest';
import { ALL_PERMISSION_AUDIT_ACTIONS } from '../src/types/permission-audit-actions.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * src/types/permission-audit-actions.ts es la única fuente de verdad para
 * permission_audit_log.action. organization_id es nullable en esta tabla,
 * así que la prueba no necesita una organización real.
 *
 * permission_audit_log es append-only (trigger forbid_perm_audit_mutation
 * bloquea UPDATE/DELETE, migración 45 BLOQUE 3) — no hay forma de limpiar
 * las filas insertadas por esta prueba. Mismo costo aceptado ya documentado
 * en __tests__/feature-audit-actions.test.ts para feature_audit_log: quedan
 * como entradas de auditoría permanentes pero inequívocamente de
 * diagnóstico (reason='diag_test_permission_audit_actions', sin
 * organization_id).
 */
describe('src/types/permission-audit-actions.ts — sincronizado con permission_audit_log_action_check', () => {
    it.each(ALL_PERMISSION_AUDIT_ACTIONS)('la acción "%s" es aceptada por permission_audit_log_action_check', async (action) => {
        const { error } = await supabaseAdmin
            .from('permission_audit_log')
            .insert({ action, reason: 'diag_test_permission_audit_actions' })
            .select('id')
            .single();

        expect(error?.code).not.toBe('23514');
    });
});
