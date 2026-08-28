import { FastifyReply, FastifyRequest } from 'fastify';
import type { LicenseTokenClaims } from './license-signing.js';

/**
 * Fase B.3 — Etapas de degradación. El orden importa: cada etapa incluye
 * las restricciones de las anteriores. `voz` no aparece aquí a propósito —
 * routes/tools/** nunca consulta este módulo, la garantía es de ausencia de
 * código, no de una etapa que "no restringe nada".
 */
export type LicenseDegradationStage = 'normal' | 'aviso' | 'features_limitadas' | 'dashboard_bloqueado';

export interface LicenseState {
    status: 'valida' | 'expirada' | 'revocada' | 'sin_token';
    claims: LicenseTokenClaims | null;
    /** Fecha del último latido exitoso enviado por esta instalación, o de emisión si aún no hay ninguno. */
    referenceDate: Date | null;
}

/**
 * Resuelve la etapa de degradación actual a partir de los umbrales que
 * viajan EN el token (nunca hardcodeados aquí — Fase B.3: "los umbrales
 * vienen del token, no del código") y de cuántos días han pasado desde el
 * último latido exitoso.
 *
 * Sin token válido (`sin_token`, `expirada`, `revocada`) se trata como la
 * etapa más severa: `dashboard_bloqueado`. Nunca existe una etapa que
 * bloquee la voz — ese es precisamente el punto de esta función: acota el
 * radio de lo que SÍ puede restringir.
 */
export function resolveLicenseStage(state: LicenseState, now: Date = new Date()): LicenseDegradationStage {
    if (state.status !== 'valida' || !state.claims || !state.referenceDate) {
        return 'dashboard_bloqueado';
    }

    const daysSinceReference = Math.floor((now.getTime() - state.referenceDate.getTime()) / (24 * 60 * 60 * 1000));
    const { warnAfterDays, limitFeaturesAfterDays, lockDashboardAfterDays } = state.claims;

    if (daysSinceReference >= lockDashboardAfterDays) return 'dashboard_bloqueado';
    if (daysSinceReference >= limitFeaturesAfterDays) return 'features_limitadas';
    if (daysSinceReference >= warnAfterDays) return 'aviso';
    return 'normal';
}

const STAGE_SEVERITY: Record<LicenseDegradationStage, number> = {
    normal: 0,
    aviso: 1,
    features_limitadas: 2,
    dashboard_bloqueado: 3,
};

/**
 * Preauth de Fastify para rutas afectadas por degradación (reportes,
 * outbound, exportación — nunca `routes/tools/**`). `maxAllowedStage` es la
 * etapa MÁS SEVERA en la que la ruta sigue funcionando; a partir de la
 * siguiente etapa, responde 403 con el motivo.
 */
export function requireLicenseStageAtMost(maxAllowedStage: LicenseDegradationStage) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const currentStage = request.licenseStage ?? 'dashboard_bloqueado';
        if (STAGE_SEVERITY[currentStage] > STAGE_SEVERITY[maxAllowedStage]) {
            return reply.status(403).send({
                statusCode: 403,
                error: 'Forbidden',
                code: 'LICENSE_DEGRADED',
                message: 'Esta función está desactivada porque la licencia de esta instalación lleva demasiado tiempo sin renovarse. La atención de voz, WhatsApp y agendamiento no se ven afectadas.',
                stage: currentStage,
            });
        }
    };
}
