import { describe, it, expect } from 'vitest';
import { ALL_FEATURE_AUDIT_ACTIONS } from '../src/types/feature-audit-actions.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * src/types/feature-audit-actions.ts es la única fuente de verdad para
 * feature_audit_log.action. organization_id es nullable en esta tabla, así
 * que la prueba no necesita una organización real ni comparte fila con
 * ningún otro archivo de test.
 *
 * feature_audit_log es append-only (trigger bloquea DELETE, igual que
 * usage_events — verificado contra la base real, no asumido). No hay forma
 * de limpiar la fila insertada por esta prueba: queda como entrada de
 * auditoría permanente pero inequívocamente de diagnóstico
 * (feature_key='diag_test_secret_keys', sin organization_id). Es el mismo
 * costo que ya pagan 1.6.E/1.6.G en entitlements.test.ts al ejercitar
 * setFeatureOverride contra la tabla real.
 */
describe('src/types/feature-audit-actions.ts — sincronizado con feature_audit_log_action_check', () => {
    it.each(ALL_FEATURE_AUDIT_ACTIONS)('la acción "%s" es aceptada por feature_audit_log_action_check', async (action) => {
        const { error } = await supabaseAdmin
            .from('feature_audit_log')
            .insert({ feature_key: 'diag_test_secret_keys', action, reason: 'diag' })
            .select('id')
            .single();

        expect(error?.code).not.toBe('23514');
    });
});
