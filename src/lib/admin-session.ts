import { SignJWT, jwtVerify } from 'jose';
import { validateEnv } from '../config/env.js';

/**
 * Sesión local de superadmin, emitida por ESTA instalación después de
 * verificar un pase de `lib/admin-passport.ts`. Simétrica (HS256) a
 * propósito — a diferencia del pase (que cruza de api.datagol.net a la
 * instalación cliente y por eso necesita firma asimétrica verificable sin
 * compartir secretos), esta sesión la firma y la verifica el MISMO proceso:
 * `ADMIN_SESSION_SECRET` nunca sale de esta instalación.
 */

const ADMIN_SESSION_ISSUER = 'datagol-admin-session';
const ADMIN_SESSION_VALIDITY_SECONDS = 60 * 60;

export interface SignedAdminSession {
    token: string;
    expiresAt: Date;
}

export type AdminSessionVerificationResult = { valid: true; email: string } | { valid: false };

function getSigningKey(secret: string): Uint8Array {
    return new TextEncoder().encode(secret);
}

/**
 * Emite la sesión local para `email` — se llama solo después de que
 * `verifyAdminPassport` haya validado el pase (`routes/admin/sso.ts`).
 */
export async function signAdminSession(email: string): Promise<SignedAdminSession> {
    const env = validateEnv();
    if (!env.ADMIN_SESSION_SECRET) {
        throw new Error('ADMIN_SESSION_SECRET no está configurado en esta instalación.');
    }

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ADMIN_SESSION_VALIDITY_SECONDS * 1000);

    const token = await new SignJWT({ email })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(ADMIN_SESSION_ISSUER)
        .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
        .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
        .sign(getSigningKey(env.ADMIN_SESSION_SECRET));

    return { token, expiresAt };
}

/**
 * Verifica una sesión local. Se usa desde `lib/platform-admin.ts` como
 * camino alternativo al de Supabase Auth — nunca lanza, cualquier fallo
 * (token ajeno, expirado, `ADMIN_SESSION_SECRET` ausente) es `valid: false`
 * para que el llamador siga con el camino existente sin romper nada.
 */
export async function verifyAdminSession(token: string | null | undefined): Promise<AdminSessionVerificationResult> {
    if (!token || !token.trim()) {
        return { valid: false };
    }

    const env = validateEnv();
    if (!env.ADMIN_SESSION_SECRET) {
        return { valid: false };
    }

    try {
        const { payload } = await jwtVerify(token, getSigningKey(env.ADMIN_SESSION_SECRET), {
            issuer: ADMIN_SESSION_ISSUER,
            algorithms: ['HS256'],
        });
        const email = typeof payload.email === 'string' ? payload.email : '';
        if (!email) return { valid: false };
        return { valid: true, email };
    } catch {
        return { valid: false };
    }
}
