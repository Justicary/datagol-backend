import { SignJWT, importPKCS8, importSPKI, jwtVerify, errors as joseErrors } from 'jose';
import { validateEnv } from '../config/env.js';
import { parseKeyMap, readUnverifiedKid } from './signing-keys.js';

/**
 * Fase A.2 — Contenido del token de licencia. Todo lo que un cliente
 * necesita para operar sin red: identificador y plan del despliegue,
 * features habilitadas, vigencia, versión de llave y los umbrales de
 * degradación (Fase B.3: "los umbrales vienen del token, no del código" —
 * un cliente no tiene acceso a la tabla `licenses` del plano de control).
 */
export interface LicenseTokenClaims {
    deploymentId: string;
    deploymentSlug: string;
    planKey: string;
    features: string[];
    fingerprint: string | null;
    warnAfterDays: number;
    limitFeaturesAfterDays: number;
    lockDashboardAfterDays: number;
}

export interface SignedLicenseToken {
    token: string;
    keyVersion: string;
    issuedAt: Date;
    expiresAt: Date;
}

export interface VerifiedLicenseToken {
    claims: LicenseTokenClaims;
    keyVersion: string;
    issuedAt: Date;
    expiresAt: Date;
}

export type LicenseVerificationFailureReason =
    | 'sin_token'
    | 'formato_invalido'
    | 'llave_desconocida'
    | 'firma_invalida'
    | 'expirado'
    | 'llaves_publicas_no_configuradas';

export interface LicenseVerificationFailure {
    valid: false;
    reason: LicenseVerificationFailureReason;
}

export interface LicenseVerificationSuccess {
    valid: true;
    result: VerifiedLicenseToken;
}

export type LicenseVerificationResult = LicenseVerificationFailure | LicenseVerificationSuccess;

const LICENSE_TOKEN_ISSUER = 'api.datagol.net';
const LICENSE_TOKEN_AUDIENCE = 'datagol-deployment';

/**
 * Firma un token de licencia con la llave privada de la versión indicada
 * (por defecto, la más reciente disponible en `CONTROL_PLANE_SIGNING_KEYS`).
 * Exclusivo del plano de control — se usa desde `services/license-service.ts`.
 */
export async function signLicenseToken(
    claims: LicenseTokenClaims,
    validityDays: number,
    keyVersion?: string
): Promise<SignedLicenseToken> {
    const env = validateEnv();
    const privateKeys = parseKeyMap(env.CONTROL_PLANE_SIGNING_KEYS);
    const versions = Object.keys(privateKeys);

    if (versions.length === 0) {
        throw new Error('CONTROL_PLANE_SIGNING_KEYS no contiene ninguna llave privada válida.');
    }

    const resolvedVersion = keyVersion ?? versions[versions.length - 1];
    const pem = privateKeys[resolvedVersion];
    if (!pem) {
        throw new Error(`No existe una llave privada de firma con versión '${resolvedVersion}'.`);
    }

    const privateKey = await importPKCS8(pem, 'EdDSA');

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + validityDays * 24 * 60 * 60 * 1000);

    const token = await new SignJWT({
        deploymentId: claims.deploymentId,
        deploymentSlug: claims.deploymentSlug,
        planKey: claims.planKey,
        features: claims.features,
        fingerprint: claims.fingerprint,
        warnAfterDays: claims.warnAfterDays,
        limitFeaturesAfterDays: claims.limitFeaturesAfterDays,
        lockDashboardAfterDays: claims.lockDashboardAfterDays,
    })
        .setProtectedHeader({ alg: 'EdDSA', kid: resolvedVersion })
        .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
        .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
        .setIssuer(LICENSE_TOKEN_ISSUER)
        .setAudience(LICENSE_TOKEN_AUDIENCE)
        .sign(privateKey);

    return { token, keyVersion: resolvedVersion, issuedAt, expiresAt };
}

/**
 * Verifica un token de licencia ÚNICAMENTE con la llave pública local —
 * nunca hace una llamada de red (Fase B.1). Se usa tanto en instalaciones
 * cliente como en la propia instancia operativa de Datagol.
 */
export async function verifyLicenseToken(token: string | null | undefined): Promise<LicenseVerificationResult> {
    if (!token || !token.trim()) {
        return { valid: false, reason: 'sin_token' };
    }

    const env = validateEnv();
    const publicKeys = parseKeyMap(env.LICENSE_PUBLIC_KEYS);

    if (Object.keys(publicKeys).length === 0) {
        return { valid: false, reason: 'llaves_publicas_no_configuradas' };
    }

    const keyVersion = readUnverifiedKid(token);
    if (!keyVersion) {
        return { valid: false, reason: 'formato_invalido' };
    }

    if (!publicKeys[keyVersion]) {
        return { valid: false, reason: 'llave_desconocida' };
    }

    try {
        const publicKey = await importSPKI(publicKeys[keyVersion], 'EdDSA');
        const { payload } = await jwtVerify(token, publicKey, {
            issuer: LICENSE_TOKEN_ISSUER,
            audience: LICENSE_TOKEN_AUDIENCE,
        });

        const claims: LicenseTokenClaims = {
            deploymentId: String(payload.deploymentId ?? ''),
            deploymentSlug: String(payload.deploymentSlug ?? ''),
            planKey: String(payload.planKey ?? ''),
            features: Array.isArray(payload.features) ? payload.features.map(String) : [],
            fingerprint: typeof payload.fingerprint === 'string' ? payload.fingerprint : null,
            warnAfterDays: Number(payload.warnAfterDays ?? 7),
            limitFeaturesAfterDays: Number(payload.limitFeaturesAfterDays ?? 15),
            lockDashboardAfterDays: Number(payload.lockDashboardAfterDays ?? 30),
        };

        return {
            valid: true,
            result: {
                claims,
                keyVersion,
                issuedAt: new Date((payload.iat ?? 0) * 1000),
                expiresAt: new Date((payload.exp ?? 0) * 1000),
            },
        };
    } catch (err: unknown) {
        if (err instanceof joseErrors.JWTExpired) {
            return { valid: false, reason: 'expirado' };
        }
        if (err instanceof joseErrors.JWTClaimValidationFailed || err instanceof joseErrors.JWSSignatureVerificationFailed) {
            return { valid: false, reason: 'firma_invalida' };
        }
        return { valid: false, reason: 'formato_invalido' };
    }
}
