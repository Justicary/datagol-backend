import { describe, it, expect } from 'vitest';
import { parseDatabaseUrl } from '../src/lib/database-url.js';

describe('src/lib/database-url.ts — parseDatabaseUrl', () => {
    it('parsea host/puerto/usuario/base cuando la contraseña no tiene caracteres especiales', () => {
        const config = parseDatabaseUrl('postgresql://miuser:milpass123@db.example.com:5432/postgres');
        expect(config.user).toBe('miuser');
        expect(config.password).toBe('milpass123');
        expect(config.host).toBe('db.example.com');
        expect(config.port).toBe(5432);
        expect(config.database).toBe('postgres');
        expect(config.connectionString).toBeUndefined();
    });

    it('parsea correctamente una contraseña con ?, / y ! sin escapar (rompería new URL())', () => {
        // Es exactamente el tipo de valor real que hace fallar `new URL()` dentro
        // de `pg`/`pg-boss` — ver src/plugins/pg-boss.ts.
        const config = parseDatabaseUrl('postgresql://appuser:p4ss?w0rd/with!chars@aws-1.pooler.supabase.com:6543/postgres');
        expect(config.user).toBe('appuser');
        expect(config.password).toBe('p4ss?w0rd/with!chars');
        expect(config.host).toBe('aws-1.pooler.supabase.com');
        expect(config.port).toBe(6543);
        expect(config.database).toBe('postgres');
    });

    it('despoja los corchetes [] de la contraseña cuando actúan como delimitador URI', () => {
        const config = parseDatabaseUrl('postgresql://appuser:[p4ss/word]@localhost:5432/postgres');
        expect(config.password).toBe('p4ss/word');
    });

    it('recae en connectionString crudo cuando el formato no coincide con host:puerto/base', () => {
        const config = parseDatabaseUrl('not-a-valid-connection-string');
        expect(config.connectionString).toBe('not-a-valid-connection-string');
        expect(config.user).toBeUndefined();
    });
});
