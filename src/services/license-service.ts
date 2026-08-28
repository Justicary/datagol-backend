import { FastifyInstance } from 'fastify';
import { signLicenseToken, type LicenseTokenClaims } from '../lib/license-signing.js';

export const DEFAULT_LICENSE_VALIDITY_DAYS = 90;
export const DEFAULT_WARN_AFTER_DAYS = 7;
export const DEFAULT_LIMIT_FEATURES_AFTER_DAYS = 15;
export const DEFAULT_LOCK_DASHBOARD_AFTER_DAYS = 30;

export class LicenseServiceError extends Error {
    constructor(message: string, public readonly statusCode: number) {
        super(message);
        this.name = 'LicenseServiceError';
    }
}

export interface LicenseRow {
    id: string;
    deployment_id: string;
    token: string;
    key_version: string;
    fingerprint: string | null;
    issued_at: string;
    expires_at: string;
    revoked_at: string | null;
    revocation_reason: string | null;
    warn_after_days: number;
    limit_features_after_days: number;
    lock_dashboard_after_days: number;
    last_heartbeat_at: string | null;
    created_at: string;
}

interface DeploymentRow {
    id: string;
    slug: string;
    plan_key: string;
    status: string;
}

async function fetchDeployment(fastify: FastifyInstance, deploymentId: string): Promise<DeploymentRow> {
    const { data, error } = await fastify.supabaseAdmin
        .from('deployments')
        .select('id, slug, plan_key, status')
        .eq('id', deploymentId)
        .maybeSingle();

    if (error || !data) {
        throw new LicenseServiceError(`No existe el despliegue '${deploymentId}'.`, 404);
    }
    return data;
}

/**
 * Features habilitadas por el plan contratado del despliegue. Un `plan_key`
 * sin filas en `plan_features` no es un error — se emite la licencia con
 * lista vacía y se registra advertencia, igual criterio de "nunca romper el
 * camino por una pieza que aún no aplica" que el resto del repo.
 */
async function resolvePlanFeatures(fastify: FastifyInstance, planKey: string): Promise<string[]> {
    const { data, error } = await fastify.supabaseAdmin
        .from('plan_features')
        .select('feature_key')
        .eq('plan_key', planKey)
        .eq('enabled', true);

    if (error || !data) {
        fastify.log.warn({ planKey, err: error?.message }, '[LicenseService] No se pudieron resolver las features del plan');
        return [];
    }
    return data.map((row) => row.feature_key as string);
}

async function logDeploymentEvent(
    fastify: FastifyInstance,
    deploymentId: string,
    eventType: string,
    description: string,
    actorUserId: string | undefined,
    metadata: Record<string, unknown> = {}
): Promise<void> {
    const { error } = await fastify.supabaseAdmin.from('deployment_events').insert({
        deployment_id: deploymentId,
        event_type: eventType,
        description,
        actor_user_id: actorUserId ?? null,
        metadata,
    });

    if (error) {
        fastify.log.error({ err: error.message, deploymentId, eventType }, '[LicenseService] Error registrando deployment_event');
    }
}

export interface IssueLicenseParams {
    deploymentId: string;
    validityDays?: number;
    warnAfterDays?: number;
    limitFeaturesAfterDays?: number;
    lockDashboardAfterDays?: number;
    fingerprint?: string | null;
    actorUserId?: string;
}

/**
 * Fase A.3 — POST /control/licenses. "La emisión ocurre al firmar el
 * contrato, no de un inventario pregenerado": se emite bajo demanda, una
 * por despliegue. Si ya existe una licencia activa (no revocada), se
 * rechaza — el llamador debe usar `rotateLicense`.
 */
export async function issueLicense(fastify: FastifyInstance, params: IssueLicenseParams): Promise<{ license: LicenseRow; rawToken: string }> {
    const deployment = await fetchDeployment(fastify, params.deploymentId);

    const { data: existing } = await fastify.supabaseAdmin
        .from('licenses')
        .select('id')
        .eq('deployment_id', deployment.id)
        .is('revoked_at', null)
        .maybeSingle();

    if (existing) {
        throw new LicenseServiceError(
            `El despliegue '${deployment.slug}' ya tiene una licencia activa (${existing.id}). Use rotate para renovarla.`,
            409
        );
    }

    const validityDays = params.validityDays ?? DEFAULT_LICENSE_VALIDITY_DAYS;
    const warnAfterDays = params.warnAfterDays ?? DEFAULT_WARN_AFTER_DAYS;
    const limitFeaturesAfterDays = params.limitFeaturesAfterDays ?? DEFAULT_LIMIT_FEATURES_AFTER_DAYS;
    const lockDashboardAfterDays = params.lockDashboardAfterDays ?? DEFAULT_LOCK_DASHBOARD_AFTER_DAYS;

    const features = await resolvePlanFeatures(fastify, deployment.plan_key);

    const claims: LicenseTokenClaims = {
        deploymentId: deployment.id,
        deploymentSlug: deployment.slug,
        planKey: deployment.plan_key,
        features,
        fingerprint: params.fingerprint ?? null,
        warnAfterDays,
        limitFeaturesAfterDays,
        lockDashboardAfterDays,
    };

    const signed = await signLicenseToken(claims, validityDays);

    const { data: license, error } = await fastify.supabaseAdmin
        .from('licenses')
        .insert({
            deployment_id: deployment.id,
            token: signed.token,
            key_version: signed.keyVersion,
            fingerprint: params.fingerprint ?? null,
            issued_at: signed.issuedAt.toISOString(),
            expires_at: signed.expiresAt.toISOString(),
            warn_after_days: warnAfterDays,
            limit_features_after_days: limitFeaturesAfterDays,
            lock_dashboard_after_days: lockDashboardAfterDays,
        })
        .select('*')
        .single();

    if (error || !license) {
        throw new LicenseServiceError(`No se pudo emitir la licencia: ${error?.message ?? 'error desconocido'}`, 500);
    }

    await logDeploymentEvent(fastify, deployment.id, 'licencia_emitida', `Licencia emitida (versión de llave ${signed.keyVersion})`, params.actorUserId, {
        licenseId: license.id,
        keyVersion: signed.keyVersion,
        expiresAt: signed.expiresAt.toISOString(),
    });

    return { license: license as LicenseRow, rawToken: signed.token };
}

export interface RevokeLicenseParams {
    licenseId: string;
    reason: string;
    actorUserId?: string;
}

/**
 * Fase A.3 — POST /control/licenses/:id/revoke. Invalida definitivamente:
 * la instalación seguirá contestando llamadas (Fase B.3), pero entra en la
 * etapa de degradación más severa en cuanto verifique de nuevo.
 */
export async function revokeLicense(fastify: FastifyInstance, params: RevokeLicenseParams): Promise<LicenseRow> {
    const { data: license, error } = await fastify.supabaseAdmin
        .from('licenses')
        .update({ revoked_at: new Date().toISOString(), revocation_reason: params.reason })
        .eq('id', params.licenseId)
        .is('revoked_at', null)
        .select('*')
        .maybeSingle();

    if (error) {
        throw new LicenseServiceError(`No se pudo revocar la licencia: ${error.message}`, 500);
    }
    if (!license) {
        throw new LicenseServiceError(`La licencia '${params.licenseId}' no existe o ya estaba revocada.`, 404);
    }

    await logDeploymentEvent(fastify, license.deployment_id, 'licencia_revocada', `Licencia revocada: ${params.reason}`, params.actorUserId, {
        licenseId: license.id,
    });

    return license as LicenseRow;
}

export interface RotateLicenseParams {
    licenseId: string;
    validityDays?: number;
    actorUserId?: string;
}

/**
 * Fase A.3 — POST /control/licenses/:id/rotate, y también el mecanismo
 * interno que usa el receptor de latido (Fase B.2: "responde con un token
 * renovado"). "Rotar sin revocar": actualiza la MISMA fila en vez de
 * revocar y crear una nueva — así el índice único de "una licencia activa
 * por despliegue" nunca se rompe y no queda un evento de revocación por
 * cada renovación diaria.
 */
export async function rotateLicense(fastify: FastifyInstance, params: RotateLicenseParams): Promise<{ license: LicenseRow; rawToken: string }> {
    const { data: existing, error: fetchError } = await fastify.supabaseAdmin
        .from('licenses')
        .select('*')
        .eq('id', params.licenseId)
        .is('revoked_at', null)
        .maybeSingle();

    if (fetchError || !existing) {
        throw new LicenseServiceError(`La licencia '${params.licenseId}' no existe o está revocada.`, 404);
    }

    const deployment = await fetchDeployment(fastify, existing.deployment_id);
    const features = await resolvePlanFeatures(fastify, deployment.plan_key);
    const validityDays = params.validityDays ?? DEFAULT_LICENSE_VALIDITY_DAYS;

    const claims: LicenseTokenClaims = {
        deploymentId: deployment.id,
        deploymentSlug: deployment.slug,
        planKey: deployment.plan_key,
        features,
        fingerprint: existing.fingerprint,
        warnAfterDays: existing.warn_after_days,
        limitFeaturesAfterDays: existing.limit_features_after_days,
        lockDashboardAfterDays: existing.lock_dashboard_after_days,
    };

    const signed = await signLicenseToken(claims, validityDays);

    const { data: license, error } = await fastify.supabaseAdmin
        .from('licenses')
        .update({
            token: signed.token,
            key_version: signed.keyVersion,
            issued_at: signed.issuedAt.toISOString(),
            expires_at: signed.expiresAt.toISOString(),
        })
        .eq('id', existing.id)
        .select('*')
        .single();

    if (error || !license) {
        throw new LicenseServiceError(`No se pudo rotar la licencia: ${error?.message ?? 'error desconocido'}`, 500);
    }

    await logDeploymentEvent(fastify, deployment.id, 'renovado', `Licencia rotada (versión de llave ${signed.keyVersion})`, params.actorUserId, {
        licenseId: license.id,
        keyVersion: signed.keyVersion,
        expiresAt: signed.expiresAt.toISOString(),
    });

    return { license: license as LicenseRow, rawToken: signed.token };
}

export async function getLicense(fastify: FastifyInstance, licenseId: string): Promise<LicenseRow> {
    const { data, error } = await fastify.supabaseAdmin.from('licenses').select('*').eq('id', licenseId).maybeSingle();

    if (error || !data) {
        throw new LicenseServiceError(`La licencia '${licenseId}' no existe.`, 404);
    }
    return data as LicenseRow;
}

export async function getActiveLicenseForDeployment(fastify: FastifyInstance, deploymentId: string): Promise<LicenseRow | null> {
    const { data, error } = await fastify.supabaseAdmin
        .from('licenses')
        .select('*')
        .eq('deployment_id', deploymentId)
        .is('revoked_at', null)
        .maybeSingle();

    if (error || !data) return null;
    return data as LicenseRow;
}
