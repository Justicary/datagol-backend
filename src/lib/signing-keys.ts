/**
 * Utilidades compartidas por todo módulo de firma/verificación Ed25519 vía
 * `jose` de este repositorio (licencias en `lib/license-signing.ts`, pase de
 * superadmin en `lib/admin-passport.ts`) — evita duplicar el parseo de
 * llaves versionadas y la lectura del `kid` sin verificar.
 */

/**
 * Parsea el JSON `{ "<key_version>": "<pem>" }` de una variable de entorno
 * de llaves. Nunca lanza — una entrada mal formada se descarta, el llamador
 * decide si eso es fatal o degrada con gracia (nunca debe tumbar el
 * arranque por sí sola).
 */
export function parseKeyMap(raw: string | undefined): Record<string, string> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const result: Record<string, string> = {};
        for (const [version, pem] of Object.entries(parsed)) {
            if (typeof pem === 'string' && pem.trim()) {
                result[version] = pem;
            }
        }
        return result;
    } catch {
        return {};
    }
}

/**
 * Lee el `kid` del encabezado de un JWT SIN verificar su firma — es
 * información pública, dice qué llave pública probar; la validación real
 * ocurre después con la llave que ese `kid` resuelve. Devuelve `undefined`
 * si el token no tiene forma de JWT o el `kid` no es una cadena.
 */
export function readUnverifiedKid(token: string): string | undefined {
    try {
        const [headerB64] = token.split('.');
        const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
        return typeof header?.kid === 'string' ? header.kid : undefined;
    } catch {
        return undefined;
    }
}
