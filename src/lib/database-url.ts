import type { PoolConfig } from 'pg';

/**
 * Parseo manual de `DATABASE_URL` a campos discretos de conexión.
 *
 * `new URL()` (usado internamente por `pg` y por `pg-boss`) falla con
 * contraseñas que contienen caracteres especiales sin escapar (`?`, `/`,
 * `!`, `[]`) — el caso real de este proyecto. Devolver los campos por
 * separado evita el parseo de URL por completo.
 */
export function parseDatabaseUrl(rawUrl: string): PoolConfig {
    try {
        const withoutScheme = rawUrl.replace(/^postgresql:\/\//, '');
        const lastAtIdx = withoutScheme.lastIndexOf('@');
        if (lastAtIdx === -1) throw new Error('No @ found');

        const credentials = withoutScheme.substring(0, lastAtIdx);
        const hostPortDb = withoutScheme.substring(lastAtIdx + 1);

        const firstColon = credentials.indexOf(':');
        const user = credentials.substring(0, firstColon);
        let password = credentials.substring(firstColon + 1);

        // Los corchetes [] son delimitadores URI, no parte de la contraseña real
        if (password.startsWith('[') && password.endsWith(']')) {
            password = password.slice(1, -1);
        }

        // Si la contraseña viene percent-encoded (%3F, %2F, %21), decodificarla
        // para entregar a pg.Pool los caracteres reales de la contraseña.
        if (password.includes('%')) {
            try {
                password = decodeURIComponent(password);
            } catch {
                // Conservar el valor original si contiene un % literal inválido
            }
        }

        const hostPortMatch = hostPortDb.match(/^([^:]+):(\d+)\/(.+)$/);
        if (!hostPortMatch) throw new Error('Invalid host:port/db format');

        return {
            user,
            password,
            host: hostPortMatch[1],
            port: parseInt(hostPortMatch[2], 10),
            database: hostPortMatch[3],
            ssl: { rejectUnauthorized: false },
        };
    } catch {
        return {
            connectionString: rawUrl,
            ssl: { rejectUnauthorized: false },
        };
    }
}
