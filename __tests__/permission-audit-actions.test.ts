import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
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

describe('permission_audit_log — append-only con SET NULL al borrar usuarios (migración 81)', () => {
    it('rechaza UPDATE y DELETE directos, pero borrar al usuario deja actor y destinatario en NULL', async () => {
        const { data: created, error: userErr } = await supabaseAdmin.auth.admin.createUser({
            email: `test-perm-audit-${crypto.randomUUID()}@example.invalid`,
            password: `Pw-${crypto.randomUUID()}`,
            email_confirm: true,
        });
        if (userErr || !created.user) throw new Error(userErr?.message);
        const userId = created.user.id;

        const { data: row, error: insErr } = await supabaseAdmin
            .from('permission_audit_log')
            .insert({
                action: 'user_invited',
                target_user_id: userId,
                actor_user_id: userId,
                reason: 'diag_test_permission_audit_user_delete',
            })
            .select('id')
            .single();
        expect(insErr).toBeNull();

        const { error: updErr } = await supabaseAdmin
            .from('permission_audit_log')
            .update({ reason: 'reescrita' })
            .eq('id', row!.id);
        expect(updErr?.message).toMatch(/append-only/);

        const { error: delErr } = await supabaseAdmin.from('permission_audit_log').delete().eq('id', row!.id);
        expect(delErr?.message).toMatch(/append-only/);

        const { error: delUserErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
        expect(delUserErr).toBeNull();

        const { data: after } = await supabaseAdmin
            .from('permission_audit_log')
            .select('action, target_user_id, actor_user_id, reason')
            .eq('id', row!.id)
            .single();
        expect(after).toEqual({
            action: 'user_invited',
            target_user_id: null,
            actor_user_id: null,
            reason: 'diag_test_permission_audit_user_delete',
        });
    });
});
