import { FastifyPluginAsync } from 'fastify';
import { supabaseAdmin } from '../../lib/supabase.js';
import { isPlatformAdmin } from '../../lib/platform-admin.js';
import {
    getOrganizationFeatures,
    setFeatureOverride,
    setOrganizationPlan,
    getFeatureAuditLog,
    clearEntitlementsCache,
} from '../../services/entitlements.js';
import { FEATURE_AUDIT_ACTIONS } from '../../types/feature-audit-actions.js';
import { PLAN_KEYS } from '../../types/feature-taxonomy.js';

interface OverrideBody {
    feature_key: string;
    is_enabled: boolean;
    reason: string;
    expires_at?: string | null;
}

interface PlanBody {
    plan_key: string;
    reason: string;
}

interface KillSwitchBody {
    globally_disabled: boolean;
    reason: string;
}

/**
 * Plugin de rutas administrativas para la gestión de entitlements y features.
 */
export const adminFeaturesRoutes: FastifyPluginAsync = async (fastify) => {
    // Proteger todas las rutas en este plugin con isPlatformAdmin
    fastify.addHook('preHandler', isPlatformAdmin);

    /**
     * GET /api/admin/features
     * Catálogo completo de características para la consola de administración.
     */
    fastify.get('/api/admin/features', async (request, reply) => {
        const { data, error } = await supabaseAdmin
            .from('features')
            .select('key, name, description, category, requires_provider, has_cost_impact, globally_disabled, disabled_reason, sort_order, created_at')
            .order('sort_order', { ascending: true });

        if (error) {
            return reply.status(500).send({ error: 'InternalServerError', message: error.message });
        }

        return reply.send({ data: data ?? [] });
    });

    /**
     * GET /api/admin/features/organization/:orgId
     * Listar las features de una organización detallando su origen (plan u override).
     */
    fastify.get<{ Params: { orgId: string } }>(
        '/api/admin/features/organization/:orgId',
        async (request, reply) => {
            const { orgId } = request.params;

            // 1. Obtener todas las features del catálogo
            const { data: allFeatures, error: featErr } = await supabaseAdmin
                .from('features')
                .select('*')
                .order('sort_order', { ascending: true });

            if (featErr) {
                return reply.status(500).send({ error: featErr.message });
            }

            // 2. Obtener plan actual de la org
            const { data: org } = await supabaseAdmin
                .from('organizations')
                .select('plan_key, max_concurrent_calls')
                .eq('id', orgId)
                .maybeSingle();

            const planKey = org?.plan_key || PLAN_KEYS.STARTER;

            // 3. Features concedidas por el plan
            const { data: planFeats } = await supabaseAdmin
                .from('plan_features')
                .select('feature_key')
                .eq('plan_key', planKey);

            const planFeatureKeys = new Set((planFeats || []).map((pf) => pf.feature_key));

            // 4. Overrides específicos de la org
            const { data: overrides } = await supabaseAdmin
                .from('organization_features')
                .select('*')
                .eq('organization_id', orgId);

            const overrideMap = new Map<string, any>();
            if (overrides) {
                for (const ov of overrides) {
                    overrideMap.set(ov.feature_key, ov);
                }
            }

            // 5. Active Set resolved
            const activeSet = await getOrganizationFeatures(orgId);

            // Armar reporte completo
            const detailedFeatures = (allFeatures || []).map((f) => {
                const ov = overrideMap.get(f.key);
                const isFromPlan = planFeatureKeys.has(f.key);
                const isCurrentlyActive = activeSet.has(f.key);

                let origin = 'none';
                if (f.globally_disabled) {
                    origin = 'kill_switch_global';
                } else if (ov) {
                    const isExpired = ov.expires_at && new Date(ov.expires_at) < new Date();
                    origin = isExpired ? 'override_expired' : (ov.is_enabled ? 'override_grant' : 'override_deny');
                } else if (isFromPlan) {
                    origin = 'plan';
                }

                return {
                    ...f,
                    is_active: isCurrentlyActive,
                    is_from_plan: isFromPlan,
                    origin,
                    override: ov || null,
                };
            });

            return reply.send({
                organization_id: orgId,
                plan_key: planKey,
                max_concurrent_calls: org?.max_concurrent_calls || 5,
                features: detailedFeatures,
            });
        }
    );

    /**
     * POST /api/admin/features/organization/:orgId/overrides
     * Activar o desactivar un override para una organización.
     */
    fastify.post<{ Params: { orgId: string }; Body: OverrideBody }>(
        '/api/admin/features/organization/:orgId/overrides',
        async (request, reply) => {
            const { orgId } = request.params;
            const { feature_key, is_enabled, reason, expires_at } = request.body || {};

            if (!feature_key || typeof is_enabled !== 'boolean') {
                return reply.status(400).send({
                    error: 'BadRequest',
                    message: 'Los campos "feature_key" (string) e "is_enabled" (boolean) son obligatorios.',
                });
            }

            const result = await setFeatureOverride(
                orgId,
                feature_key,
                is_enabled,
                reason,
                expires_at
            );

            if (!result.success) {
                return reply.status(400).send({
                    error: 'OverrideFailed',
                    message: result.error,
                });
            }

            return reply.status(200).send({
                message: `Override para '${feature_key}' aplicado con éxito en la organización '${orgId}'.`,
            });
        }
    );

    /**
     * POST /api/admin/features/organization/:orgId/plan
     * Cambiar el plan de una organización y sincronizar max_concurrent_calls.
     */
    fastify.post<{ Params: { orgId: string }; Body: PlanBody }>(
        '/api/admin/features/organization/:orgId/plan',
        async (request, reply) => {
            const { orgId } = request.params;
            const { plan_key, reason } = request.body || {};

            if (!plan_key || typeof plan_key !== 'string') {
                return reply.status(400).send({
                    error: 'BadRequest',
                    message: 'El campo "plan_key" es obligatorio.',
                });
            }

            const result = await setOrganizationPlan(orgId, plan_key, reason);

            if (!result.success) {
                return reply.status(400).send({
                    error: 'PlanChangeFailed',
                    message: result.error,
                });
            }

            return reply.status(200).send({
                message: `Plan de la organización '${orgId}' actualizado con éxito a '${plan_key}'.`,
            });
        }
    );

    /**
     * GET /api/admin/features/organization/:orgId/audit-log
     * Consultar la bitácora de auditoría de características de una organización.
     */
    fastify.get<{ Params: { orgId: string } }>(
        '/api/admin/features/organization/:orgId/audit-log',
        async (request, reply) => {
            const { orgId } = request.params;
            try {
                const logs = await getFeatureAuditLog(orgId);
                return reply.send({ organization_id: orgId, audit_logs: logs });
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    );

    /**
     * POST /api/admin/features/:featureKey/kill-switch
     * Kill switch global: afecta a todos los tenants a la vez. Se audita con
     * organization_id: null (la fila es nullable exactamente para este caso).
     */
    fastify.post<{ Params: { featureKey: string }; Body: KillSwitchBody }>(
        '/api/admin/features/:featureKey/kill-switch',
        async (request, reply) => {
            const { featureKey } = request.params;
            const { globally_disabled, reason } = request.body || {};

            if (typeof globally_disabled !== 'boolean') {
                return reply.status(400).send({
                    error: 'BadRequest',
                    message: 'El campo "globally_disabled" (boolean) es obligatorio.',
                });
            }
            if (!reason || typeof reason !== 'string' || reason.trim() === '') {
                return reply.status(400).send({ error: 'BadRequest', message: 'El campo "reason" es obligatorio.' });
            }

            const { data: feature, error: featureErr } = await supabaseAdmin
                .from('features')
                .select('key')
                .eq('key', featureKey)
                .maybeSingle();

            if (featureErr || !feature) {
                return reply.status(404).send({ error: 'NotFound', message: `La feature '${featureKey}' no existe.` });
            }

            const trimmedReason = reason.trim();
            const { error: updateErr } = await supabaseAdmin
                .from('features')
                .update({
                    globally_disabled,
                    disabled_reason: globally_disabled ? trimmedReason : null,
                })
                .eq('key', featureKey);

            if (updateErr) {
                return reply.status(500).send({ error: 'InternalServerError', message: updateErr.message });
            }

            const { error: auditErr } = await supabaseAdmin
                .from('feature_audit_log')
                .insert({
                    organization_id: null,
                    feature_key: featureKey,
                    action: globally_disabled ? FEATURE_AUDIT_ACTIONS.DISABLED : FEATURE_AUDIT_ACTIONS.ENABLED,
                    reason: trimmedReason,
                });

            if (auditErr) {
                request.log.error({ err: auditErr, featureKey, msg: 'Error registrando auditoría de kill switch global' });
            }

            // Kill switch global: afecta a todos los tenants, se limpia todo el caché.
            clearEntitlementsCache();

            return reply.status(200).send({
                message: `Kill switch de '${featureKey}' ${globally_disabled ? 'activado' : 'desactivado'} con éxito.`,
            });
        }
    );
};

export default adminFeaturesRoutes;
