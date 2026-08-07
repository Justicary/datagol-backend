import { supabaseAdmin } from '../lib/supabase.js';
import { FEATURE_AUDIT_ACTIONS } from '../types/feature-audit-actions.js';
import { clearEntitlementsCache } from './entitlements.js';
import { logger } from '../lib/logger.js';

export type OrganizationStatus = 'active' | 'suspended';

export interface AdminOrganizationSummary {
    id: string;
    name: string;
    email: string | null;
    plan_key: string | null;
    status: OrganizationStatus;
    suspended_reason: string | null;
    suspended_at: string | null;
    kyc_status: string | null;
    max_concurrent_calls: number | null;
    webhook_token_present: boolean;
    agent_reprovision_pending: boolean;
    created_at: string | null;
}

/**
 * Suspende o reactiva una organización — apaga (o restaura) todo lo que
 * Datagol controla para ese tenant: dashboard, tool calls y webhook de
 * cierre de llamada. No detiene la llamada de voz en sí (infraestructura
 * propia del cliente, fuera del control de Datagol).
 */
export async function setOrganizationStatus(
    organizationId: string,
    status: OrganizationStatus,
    reason: string,
    _changedByUserId?: string
): Promise<{ success: boolean; error?: string }> {
    if (!reason || reason.trim() === '') {
        return { success: false, error: 'El campo "reason" es obligatorio para cambiar el estado de la organización.' };
    }

    const { data: org, error: readErr } = await supabaseAdmin
        .from('organizations')
        .select('status, suspended_reason, suspended_at')
        .eq('id', organizationId)
        .maybeSingle();

    if (readErr || !org) {
        return { success: false, error: 'La organización no existe.' };
    }

    const previousStatus = org.status as OrganizationStatus;
    if (previousStatus === status) {
        return { success: false, error: `La organización ya está en estado "${status}".` };
    }

    const trimmedReason = reason.trim();
    const { error: updateErr } = await supabaseAdmin
        .from('organizations')
        .update({
            status,
            suspended_reason: status === 'suspended' ? trimmedReason : null,
            suspended_at: status === 'suspended' ? new Date().toISOString() : null,
            updated_at: new Date().toISOString(),
        })
        .eq('id', organizationId);

    if (updateErr) {
        return { success: false, error: `Error actualizando el estado de la organización: ${updateErr.message}` };
    }

    const { error: auditErr } = await supabaseAdmin
        .from('feature_audit_log')
        .insert({
            organization_id: organizationId,
            feature_key: 'organization:status',
            action: status === 'suspended' ? FEATURE_AUDIT_ACTIONS.SUSPENDED : FEATURE_AUDIT_ACTIONS.REACTIVATED,
            reason: trimmedReason,
            previous_value: previousStatus === 'suspended',
            new_value: status === 'suspended',
        });

    if (auditErr) {
        // Revertir el UPDATE: una suspensión (o reactivación) sin bitácora es
        // el mismo escenario que setFeatureOverride() ya trata como fallo total.
        await supabaseAdmin
            .from('organizations')
            .update({
                status: previousStatus,
                suspended_reason: org.suspended_reason,
                suspended_at: org.suspended_at,
            })
            .eq('id', organizationId);

        return {
            success: false,
            error: `Fallo al registrar en la bitácora de auditoría. El cambio fue revertido: ${auditErr.message}`,
        };
    }

    clearEntitlementsCache(organizationId);

    return { success: true };
}

/**
 * Listado administrativo de organizaciones. `webhook_token` nunca sale de
 * este módulo crudo — solo su presencia (patrón ya establecido para
 * organization_secrets/provider_rates: "muestra si existe, nunca el valor").
 */
export async function listOrganizationsForAdmin(): Promise<AdminOrganizationSummary[]> {
    const { data, error } = await supabaseAdmin
        .from('organizations')
        .select(
            'id, name, email, plan_key, status, suspended_reason, suspended_at, kyc_status, max_concurrent_calls, webhook_token, agent_reprovision_pending, created_at'
        )
        .order('created_at', { ascending: false, nullsFirst: false });

    if (error) {
        logger.error({ err: error }, '[OrganizationLifecycle] Error al listar organizaciones para admin');
        throw new Error(`Error al listar organizaciones: ${error.message}`);
    }

    return (data || []).map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        plan_key: row.plan_key,
        status: row.status,
        suspended_reason: row.suspended_reason,
        suspended_at: row.suspended_at,
        kyc_status: row.kyc_status,
        max_concurrent_calls: row.max_concurrent_calls,
        webhook_token_present: row.webhook_token !== null,
        agent_reprovision_pending: row.agent_reprovision_pending,
        created_at: row.created_at,
    }));
}
