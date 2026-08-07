import { supabaseAdmin } from '../lib/supabase.js';
import { getSecret } from './secret-service.js';
import { SECRET_KEYS, type SecretKey } from '../types/secret-keys.js';
import { logger } from '../lib/logger.js';

export interface EntitlementsCacheItem {
    enabledFeatures: Set<string>;
    expiresAt: number;
}

export const FEATURE_AUDIT_ACTIONS = {
    ENABLED: 'enabled',
    DISABLED: 'disabled',
    OVERRIDDEN: 'overridden',
    KILL_SWITCH_ENGAGED: 'kill_switch_engaged',
    KILL_SWITCH_DISENGAGED: 'kill_switch_disengaged',
    PLAN_CHANGED: 'plan_changed',
} as const;

const ENTITLEMENTS_CACHE_TTL_MS = 30 * 1000; // 30s TTL
const entitlementsCache = new Map<string, EntitlementsCacheItem>();

/**
 * Resuelve las características (*features*) habilitadas para una organización.
 * Precedencia estricta:
 *   1. Kill switch global (`features.globally_disabled = true` -> DENEGADO)
 *   2. Override de la organización (`organization_features.enabled` no expirado -> ACEPTADO/DENEGADO)
 *   3. Plan contratado (`plan_features` -> ACEPTADO)
 *   4. Denegado por defecto.
 */
export async function getOrganizationFeatures(organizationId: string): Promise<Set<string>> {
    if (!organizationId) {
        return new Set();
    }

    const now = Date.now();
    const cached = entitlementsCache.get(organizationId);
    if (cached && cached.expiresAt > now) {
        return cached.enabledFeatures;
    }

    // 1. Obtener kill switches globales (`globally_disabled = true`)
    const { data: globalFeatures } = await supabaseAdmin
        .from('features')
        .select('key, globally_disabled');

    const globallyDisabledSet = new Set<string>();
    if (globalFeatures) {
        for (const f of globalFeatures) {
            if (f.globally_disabled === true) {
                globallyDisabledSet.add(f.key);
            }
        }
    }

    // 2. Intentar llamar a la función RPC `organization_enabled_features`
    const { data: rpcData, error: rpcErr } = await supabaseAdmin
        .rpc('organization_enabled_features', { p_org_id: organizationId });

    if (!rpcErr && Array.isArray(rpcData)) {
        const enabledFeatureKeys = rpcData.map((item: Record<string, unknown> | string) =>
            typeof item === 'string' ? item : (item.feature_key || item.key) as string
        );

        // Filtrar cualquier feature afectada por kill switch global
        const finalSet = new Set<string>();
        for (const k of enabledFeatureKeys) {
            if (!globallyDisabledSet.has(k)) {
                finalSet.add(k);
            }
        }

        entitlementsCache.set(organizationId, {
            enabledFeatures: finalSet,
            expiresAt: now + ENTITLEMENTS_CACHE_TTL_MS,
        });

        return finalSet;
    }

    // Fallback en JS si el RPC no retorna o falla
    const { data: org } = await supabaseAdmin
        .from('organizations')
        .select('plan_key')
        .eq('id', organizationId)
        .maybeSingle();

    const planKey = org?.plan_key || 'starter';

    // Cargar features del plan
    const { data: planFeatures } = await supabaseAdmin
        .from('plan_features')
        .select('feature_key')
        .eq('plan_key', planKey);

    const resultSet = new Set<string>();
    if (planFeatures) {
        for (const pf of planFeatures) {
            resultSet.add(pf.feature_key);
        }
    }

    // Cargar overrides de la organización
    const { data: orgOverrides } = await supabaseAdmin
        .from('organization_features')
        .select('feature_key, enabled, expires_at')
        .eq('organization_id', organizationId);

    if (orgOverrides) {
        const isoNow = new Date().toISOString();
        for (const ov of orgOverrides) {
            if (ov.expires_at && ov.expires_at < isoNow) {
                continue;
            }
            if (ov.enabled) {
                resultSet.add(ov.feature_key);
            } else {
                resultSet.delete(ov.feature_key);
            }
        }
    }

    // Aplicar kill switches globales sobre el fallback
    for (const disabledKey of globallyDisabledSet) {
        resultSet.delete(disabledKey);
    }

    entitlementsCache.set(organizationId, {
        enabledFeatures: resultSet,
        expiresAt: now + ENTITLEMENTS_CACHE_TTL_MS,
    });

    return resultSet;
}

/**
 * Verifica si una feature está habilitada para la organización.
 */
export async function isFeatureEnabled(organizationId: string, featureKey: string): Promise<boolean> {
    const features = await getOrganizationFeatures(organizationId);
    return features.has(featureKey);
}

/**
 * Guarda de credenciales previa a habilitar una feature que requiere proveedor.
 */
export async function checkProviderCredentials(
    organizationId: string,
    featureKey: string
): Promise<{ ok: boolean; requiredProvider?: string; missingSecret?: string }> {
    const { data: feature } = await supabaseAdmin
        .from('features')
        .select('requires_provider')
        .eq('key', featureKey)
        .maybeSingle();

    if (!feature || !feature.requires_provider) {
        return { ok: true };
    }

    const provider = feature.requires_provider;
    let secretKey: SecretKey | null = null;

    switch (provider) {
        case 'elevenlabs':
            secretKey = SECRET_KEYS.ELEVENLABS_API_KEY;
            break;
        case 'telnyx':
            secretKey = SECRET_KEYS.TELNYX_API_KEY;
            break;
        case 'cal':
            secretKey = SECRET_KEYS.CAL_API_KEY;
            break;
        case 'meta':
            secretKey = SECRET_KEYS.WHATSAPP_ACCESS_TOKEN;
            break;
    }

    if (!secretKey) {
        return { ok: true };
    }

    const secretVal = await getSecret(organizationId, secretKey);
    if (!secretVal || secretVal.trim() === '') {
        return {
            ok: false,
            requiredProvider: provider,
            missingSecret: secretKey,
        };
    }

    return { ok: true };
}

/**
 * Activa o desactiva un override de feature para una organización.
 * Requiere un `reason` obligatorio.
 */
export async function setFeatureOverride(
    organizationId: string,
    featureKey: string,
    isEnabled: boolean,
    reason: string,
    expiresAt?: string | null,
    _changedByUserId?: string
): Promise<{ success: boolean; error?: string }> {
    if (!reason || reason.trim() === '') {
        return { success: false, error: 'El campo "reason" es obligatorio para registrar un cambio de entitlement.' };
    }

    // Guarda de credenciales al habilitar
    if (isEnabled) {
        const credCheck = await checkProviderCredentials(organizationId, featureKey);
        if (!credCheck.ok) {
            return {
                success: false,
                error: `No se puede habilitar '${featureKey}': Faltan las credenciales del proveedor '${credCheck.requiredProvider}' (${credCheck.missingSecret}) en organization_secrets.`,
            };
        }
    }

    // 1. Aplicar override
    const { error: overrideErr } = await supabaseAdmin
        .from('organization_features')
        .upsert(
            {
                organization_id: organizationId,
                feature_key: featureKey,
                enabled: isEnabled,
                reason: reason.trim(),
                expires_at: expiresAt || null,
            },
            { onConflict: 'organization_id,feature_key' }
        );

    if (overrideErr) {
        return { success: false, error: `Error guardando override: ${overrideErr.message}` };
    }

    // 2. Registrar en la bitácora de auditoría.
    const { error: auditErr } = await supabaseAdmin
        .from('feature_audit_log')
        .insert({
            organization_id: organizationId,
            feature_key: featureKey,
            action: isEnabled ? FEATURE_AUDIT_ACTIONS.ENABLED : FEATURE_AUDIT_ACTIONS.DISABLED,
            reason: reason.trim(),
            new_value: isEnabled,
        });

    if (auditErr) {
        // Revertir cambio en caso de fallo de auditoría
        await supabaseAdmin
            .from('organization_features')
            .delete()
            .eq('organization_id', organizationId)
            .eq('feature_key', featureKey);

        return {
            success: false,
            error: `Fallo al registrar en la bitácora de auditoría. El cambio fue revertido: ${auditErr.message}`,
        };
    }

    clearEntitlementsCache(organizationId);

    // El agente queda desincronizado de los entitlements vigentes hasta que
    // reprovisionAgent() (abajo) limpie esta marca. Si el UPDATE falla, se
    // registra pero no aborta la operación — el override ya quedó aplicado
    // y auditado, que es lo que no puede perderse.
    const { error: reprovisionFlagErr } = await supabaseAdmin
        .from('organizations')
        .update({ agent_reprovision_pending: true })
        .eq('id', organizationId);
    if (reprovisionFlagErr) {
        logger.warn({ err: reprovisionFlagErr, organizationId }, '[Entitlements] No se pudo marcar agent_reprovision_pending');
    }

    // Sincronizar reprovisión de agente
    try {
        const { reprovisionAgent } = await import('./agent-provisioning.js');
        await reprovisionAgent(organizationId);
    } catch (provErr) {
        logger.warn({ err: provErr, organizationId }, '[Entitlements] Advertencia al reprovisionar agente');
    }

    return { success: true };
}

/**
 * Cambia el plan de una organización y sincroniza `max_concurrent_calls`.
 */
export async function setOrganizationPlan(
    organizationId: string,
    planKey: string,
    reason: string,
    _changedByUserId?: string
): Promise<{ success: boolean; error?: string }> {
    if (!reason || reason.trim() === '') {
        return { success: false, error: 'El campo "reason" es obligatorio para cambiar el plan.' };
    }

    // Obtener detalles del plan
    const { data: plan, error: planErr } = await supabaseAdmin
        .from('plans')
        .select('*')
        .eq('key', planKey)
        .maybeSingle();

    if (planErr || !plan) {
        return { success: false, error: `El plan '${planKey}' no existe.` };
    }

    // Actualizar organización
    const { error: updateErr } = await supabaseAdmin
        .from('organizations')
        .update({
            plan_key: planKey,
            max_concurrent_calls: plan.max_concurrent_calls,
            // El agente queda desincronizado de los entitlements vigentes
            // hasta que reprovisionAgent() (abajo) limpie esta marca.
            agent_reprovision_pending: true,
            updated_at: new Date().toISOString(),
        })
        .eq('id', organizationId);

    if (updateErr) {
        return { success: false, error: `Error actualizando plan de organización: ${updateErr.message}` };
    }

    const { error: auditErr } = await supabaseAdmin
        .from('feature_audit_log')
        .insert({
            organization_id: organizationId,
            feature_key: `plan:${planKey}`,
            action: FEATURE_AUDIT_ACTIONS.PLAN_CHANGED,
            reason: reason.trim(),
        });

    if (auditErr) {
        logger.error({ err: auditErr, organizationId, planKey }, '[Entitlements] Error registrando auditoría de cambio de plan');
    }

    clearEntitlementsCache(organizationId);

    try {
        const { reprovisionAgent } = await import('./agent-provisioning.js');
        await reprovisionAgent(organizationId);
    } catch (provErr) {
        logger.warn({ err: provErr, organizationId }, '[Entitlements] Advertencia al reprovisionar agente tras cambio de plan');
    }

    return { success: true };
}

/**
 * Consulta la bitácora de auditoría de features para una organización.
 */
export async function getFeatureAuditLog(organizationId: string) {
    const { data, error } = await supabaseAdmin
        .from('feature_audit_log')
        .select('*')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false });

    if (error) {
        throw new Error(`Error al consultar bitácora de auditoría: ${error.message}`);
    }

    return data || [];
}

/**
 * Limpia la memoria caché de entitlements.
 */
export function clearEntitlementsCache(organizationId?: string): void {
    if (!organizationId) {
        entitlementsCache.clear();
        return;
    }
    entitlementsCache.delete(organizationId);
}
