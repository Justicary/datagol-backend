import crypto from 'crypto';
import { SignJWT, importPKCS8, importSPKI, jwtVerify, errors as joseErrors } from 'jose';
import { validateEnv } from '../config/env.js';
import { parseKeyMap, readUnverifiedKid } from './signing-keys.js';

/**
 * Pasaporte de superadmin — SSO delegado a api.datagol.net (aprovecha la
 * misma infraestructura Ed25519/`jose` de `lib/license-signing.ts`, pero
 * con llaves y alcance completamente separados: comprometer la llave de
 * licencias no debe dar acceso admin, y viceversa).
 *
 * Emitido SOLO por api.datagol.net (`routes/control/admin-passport.ts`,
 * exclusivo de `CONTROL_PLANE=true`) para UN despliegue específico
 * (`aud` = `deployments.id`) y de un solo uso (`jti` rastreado aquí mismo).
 * Verificado localmente por cada instalación cliente, sin llamada de red,
 * contra `ADMIN_PASSPORT_PUBLIC_KEYS`.
 */

const ADMIN_PASSPORT_ISSUER = 'api.datagol.net';
const ADMIN_PASSPORT_VALIDITY_SECONDS = 5 * 60;

export interface AdminPassportClaims {
    sub: string;
    email: string;
    deploymentId: string;
}

export interface SignedAdminPassport {
    token: string;
    jti: string;
    keyVersion: string;
    expiresAt: Date;
}

export type AdminPassportVerificationFailureReason =
    | 'sin_token'
    | 'formato_invalido'
    | 'llave_desconocida'
    | 'firma_invalida'
    | 'expirado'
    | 'ya_usado'
    | 'llaves_publicas_no_configuradas';

export type AdminPassportVerificationResult =
    | { valid: true; claims: AdminPassportClaims }
    | { valid: false; reason: AdminPassportVerificationFailureReason };

/**
 * Firma un pase para `claims.deploymentId`. Exclusivo del plano de control
 * — se usa desde `routes/control/admin-passport.ts`.
 */
export async function signAdminPassport(claims: AdminPassportClaims): Promise<SignedAdminPassport> {
    const env = validateEnv();
    const privateKeys = parseKeyMap(env.ADMIN_PASSPORT_SIGNING_KEYS);
    const versions = Object.keys(privateKeys);

    if (versions.length === 0) {
        throw new Error('ADMIN_PASSPORT_SIGNING_KEYS no contiene ninguna llave privada válida.');
    }

    const keyVersion = versions[versions.length - 1];
    const privateKey = await importPKCS8(privateKeys[keyVersion], 'EdDSA');

    const jti = crypto.randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ADMIN_PASSPORT_VALIDITY_SECONDS * 1000);

    const token = await new SignJWT({ email: claims.email })
        .setProtectedHeader({ alg: 'EdDSA', kid: keyVersion })
        .setSubject(claims.sub)
        .setAudience(claims.deploymentId)
        .setIssuer(ADMIN_PASSPORT_ISSUER)
        .setJti(jti)
        .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
        .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
        .sign(privateKey);

    return { token, jti, keyVersion, expiresAt };
}

// jti ya consumidos, en memoria — mismo criterio de "un solo proceso, un
// solo uso" que el resto de trackers en memoria de este repo
// (lib/rate-limiter.ts, lib/tool-latency-tracker.ts). Suficiente porque el
// pase vive 5 minutos y cada instalación es un proceso propio: no necesita
// sobrevivir un reinicio ni compartirse entre réplicas para cumplir su
// propósito (impedir que el MISMO enlace se reutilice después de ya usarse).
const usedJti = new Map<string, number>();

function pruneExpiredJti(nowMs: number): void {
    for (const [jti, expiresAtMs] of usedJti) {
        if (expiresAtMs < nowMs) usedJti.delete(jti);
    }
}

export function clearUsedJtiForTesting(): void {
    usedJti.clear();
}

/**
 * Verifica un pase ÚNICAMENTE con la llave pública local (sin red) y que
 * `aud` coincida con `expectedDeploymentId` — el `DEPLOYMENT_ID` de ESTA
 * instalación. Un pase emitido para otro despliegue se rechaza aquí mismo,
 * antes de llegar siquiera a `jwtVerify` con la audiencia equivocada.
 */
export async function verifyAdminPassport(
    token: string | null | undefined,
    expectedDeploymentId: string
): Promise<AdminPassportVerificationResult> {
    if (!token || !token.trim()) {
        return { valid: false, reason: 'sin_token' };
    }

    const env = validateEnv();
    const publicKeys = parseKeyMap(env.ADMIN_PASSPORT_PUBLIC_KEYS);

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
            issuer: ADMIN_PASSPORT_ISSUER,
            audience: expectedDeploymentId,
        });

        const jti = typeof payload.jti === 'string' ? payload.jti : '';
        if (!jti) {
            return { valid: false, reason: 'formato_invalido' };
        }

        const now = Date.now();
        pruneExpiredJti(now);
        if (usedJti.has(jti)) {
            return { valid: false, reason: 'ya_usado' };
        }
        usedJti.set(jti, (payload.exp ?? 0) * 1000);

        return {
            valid: true,
            claims: {
                sub: String(payload.sub ?? ''),
                email: String(payload.email ?? ''),
                deploymentId: expectedDeploymentId,
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
