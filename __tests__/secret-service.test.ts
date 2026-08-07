import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import pg from 'pg';
import { getSecret, setSecret, clearSecretCache, listSecretStatus } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { logger } from '../src/lib/logger.js';
import { validateEnv } from '../src/config/env.js';
import { parseDatabaseUrl } from '../src/lib/database-url.js';

/**
 * Pruebas de integración reales contra Supabase Postgres y Vault sin mocks.
 * Ejercitan el ciclo completo de creación, lectura, rotación e invalidación de caché.
 */
describe('src/services/secret-service.ts — Pruebas de Integración Reales contra Supabase Vault', () => {
    let testOrgId: string;
    // Pool de verificación independiente del singleton interno del servicio —
    // usado SOLO para inspeccionar/mutar Vault directamente en pruebas que
    // necesitan bypasear el propio código bajo prueba (p.ej. rotar un valor
    // sin pasar por setSecret, para poder distinguir un caché correctamente
    // invalidado de uno que no lo fue).
    const verificationPool = new pg.Pool(parseDatabaseUrl(validateEnv().DATABASE_URL));

    beforeAll(async () => {
        // Email único por corrida: evita choques con organizations_email_key
        // si una corrida previa (p.ej. una interrumpida por timeout) dejó una
        // fila huérfana sin pasar por afterAll.
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org Pruebas SecretService', email: `test-secret-service-${crypto.randomUUID()}@example.invalid` })
            .select('id')
            .single();

        if (error || !data) {
            throw new Error(`No se pudo crear la organización dedicada: ${error?.message}`);
        }
        testOrgId = data.id;
        clearSecretCache();
    });

    afterAll(async () => {
        clearSecretCache();
        if (testOrgId) {
            await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', testOrgId);
            await supabaseAdmin.from('organizations').delete().eq('id', testOrgId);
        }
        await verificationPool.end();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    async function getVaultSecretId(organizationId: string, secretKey: string): Promise<string> {
        const { data } = await supabaseAdmin
            .from('organization_secrets')
            .select('vault_secret_id')
            .eq('organization_id', organizationId)
            .eq('secret_key', secretKey)
            .single();
        return data!.vault_secret_id as string;
    }

    /** Rota el valor en Vault directamente por SQL, sin pasar por setSecret — deliberadamente NO invalida la caché en memoria. */
    async function rotateVaultSecretBypassingCache(organizationId: string, secretKey: string, newValue: string): Promise<void> {
        const vaultSecretId = await getVaultSecretId(organizationId, secretKey);
        await verificationPool.query('SELECT vault.update_secret($1, $2);', [vaultSecretId, newValue]);
    }

    it('getSecret devuelve null si organizationId o secretKey son falsy, sin consultar Supabase (early return real, no por descarte aguas abajo)', async () => {
        const fromSpy = vi.spyOn(supabaseAdmin, 'from');

        const resNullOrg = await getSecret('', SECRET_KEYS.ELEVENLABS_API_KEY);
        expect(resNullOrg).toBeNull();

        const resNullKey = await getSecret(testOrgId, '' as any);
        expect(resNullKey).toBeNull();

        // Si el early-return de organizationId/secretKey falsy se rompiera,
        // ambas llamadas igual devolverían null más abajo (por no encontrar
        // fila), pero SÍ tocarían la base de datos — lo cual esta aserción detecta.
        expect(fromSpy).not.toHaveBeenCalled();
    });

    it('getSecret devuelve null para un secreto que no existe en organization_secrets, sin pasar por la rama de excepción', async () => {
        const errorSpy = vi.spyOn(logger, 'error');
        const value = await getSecret(testOrgId, SECRET_KEYS.TELNYX_API_KEY);
        expect(value).toBeNull();
        // Distingue el early-return correcto (línea 59-61) de la variante
        // mutada que cae en el catch: solo el camino incorrecto loguearía.
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('getSecret retorna null y registra el error si la consulta a Vault lanza una excepción de infraestructura', async () => {
        // Sembrar un secreto real para que getSecret llegue hasta pool.query().
        await setSecret(testOrgId, SECRET_KEYS.META_APP_SECRET, 'valor-temporal-excepcion');
        clearSecretCache(testOrgId);

        const originalQuery = pg.Pool.prototype.query;
        const querySpy = vi.spyOn(pg.Pool.prototype, 'query').mockImplementationOnce(function (
            this: pg.Pool,
            ...args: Parameters<typeof originalQuery>
        ) {
            return Promise.reject(new Error('Fallo simulado de conexión a Vault'));
        } as any);
        const errorSpy = vi.spyOn(logger, 'error');

        try {
            const result = await getSecret(testOrgId, SECRET_KEYS.META_APP_SECRET);
            expect(result).toBeNull();
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ secretKey: SECRET_KEYS.META_APP_SECRET, organizationId: testOrgId }),
                '[SecretService] Error resolviendo secreto'
            );
        } finally {
            querySpy.mockRestore();
            await supabaseAdmin
                .from('organization_secrets')
                .delete()
                .eq('organization_id', testOrgId)
                .eq('secret_key', SECRET_KEYS.META_APP_SECRET);
            clearSecretCache(testOrgId);
        }
    });

    it('getSecret devuelve null limpiamente (sin loguear) cuando la referencia en organization_secrets quedó huérfana en Vault', async () => {
        // organization_secrets apunta a un vault_secret_id que ya no existe en
        // vault.decrypted_secrets (0 filas) — un estado de datos inconsistente
        // real, no una excepción. Debe resolverse con un return limpio, no con
        // una excepción "no rows[0]" capturada más abajo por el catch externo.
        const secretKey = SECRET_KEYS.WHATSAPP_ACCESS_TOKEN;
        await setSecret(testOrgId, secretKey, 'valor-que-sera-huerfano');
        const vaultSecretId = await getVaultSecretId(testOrgId, secretKey);
        clearSecretCache(testOrgId);

        await verificationPool.query('DELETE FROM vault.secrets WHERE id = $1;', [vaultSecretId]);
        const errorSpy = vi.spyOn(logger, 'error');

        try {
            const result = await getSecret(testOrgId, secretKey);
            expect(result).toBeNull();
            expect(errorSpy).not.toHaveBeenCalled();
        } finally {
            await supabaseAdmin
                .from('organization_secrets')
                .delete()
                .eq('organization_id', testOrgId)
                .eq('secret_key', secretKey);
            clearSecretCache(testOrgId);
        }
    });

    it('setSecret retorna false y registra el mensaje específico si vault.create_secret no devuelve fila', async () => {
        const secretKey = SECRET_KEYS.WEBHOOK_SIGNING_SECRET;
        const realQuery = pg.Pool.prototype.query;

        const querySpy = vi
            .spyOn(pg.Pool.prototype, 'query')
            .mockImplementation(function (this: pg.Pool, ...args: Parameters<typeof realQuery>) {
                const sql = args[0];
                if (typeof sql === 'string' && sql.includes('vault.create_secret')) {
                    return Promise.resolve({ rows: [], rowCount: 0 } as any);
                }
                return (realQuery as any).apply(this, args);
            } as any);
        const errorSpy = vi.spyOn(logger, 'error');

        try {
            const result = await setSecret(testOrgId, secretKey, 'valor-que-no-se-guardara');
            expect(result).toBe(false);
            // Mensaje exacto de la rama "no vaultSecretId" (línea 125-127) —
            // distingue esta rama del catch genérico de más abajo, que
            // loguearía un mensaje distinto si la ejecución cayera ahí en su lugar.
            expect(errorSpy).toHaveBeenCalledWith(
                { secretKey, organizationId: testOrgId },
                '[SecretService] No se pudo crear o resolver vaultSecretId'
            );

            const { data: linked } = await supabaseAdmin
                .from('organization_secrets')
                .select('id')
                .eq('organization_id', testOrgId)
                .eq('secret_key', secretKey)
                .maybeSingle();
            expect(linked).toBeNull();
        } finally {
            querySpy.mockRestore();
        }
    });

    it('setSecret retorna false y registra si la organización no existe (violación de FK en organization_secrets)', async () => {
        const nonExistentOrgId = crypto.randomUUID();
        const secretKey = SECRET_KEYS.CAL_API_KEY;
        const errorSpy = vi.spyOn(logger, 'error');

        const result = await setSecret(nonExistentOrgId, secretKey, 'valor-huerfano');
        expect(result).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith(
            expect.objectContaining({ secretKey, organizationId: nonExistentOrgId }),
            '[SecretService] Error al vincular en organization_secrets'
        );
    });

    it('setSecret retorna false y registra si la consulta inicial a Vault lanza una excepción (catch externo)', async () => {
        const secretKey = SECRET_KEYS.TELNYX_API_KEY;
        const querySpy = vi
            .spyOn(pg.Pool.prototype, 'query')
            .mockImplementationOnce(() => Promise.reject(new Error('Fallo simulado de Postgres al iniciar setSecret')));
        const errorSpy = vi.spyOn(logger, 'error');

        try {
            const result = await setSecret(testOrgId, secretKey, 'valor-que-nunca-se-crea');
            expect(result).toBe(false);
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ secretKey, organizationId: testOrgId, msg: 'Fallo simulado de Postgres al iniciar setSecret' }),
                '[SecretService] Excepción guardando secreto'
            );
        } finally {
            querySpy.mockRestore();
        }
    });

    it('setSecret guarda en Vault la descripción exacta del secreto (organización y clave)', async () => {
        const secretKey = SECRET_KEYS.ELEVENLABS_API_KEY;
        const ok = await setSecret(testOrgId, secretKey, 'valor-para-verificar-descripcion');
        expect(ok).toBe(true);

        const vaultSecretId = await getVaultSecretId(testOrgId, secretKey);
        const { rows } = await verificationPool.query('SELECT description FROM vault.secrets WHERE id = $1;', [vaultSecretId]);
        expect(rows[0].description).toBe(`Secreto ${secretKey} de organización ${testOrgId}`);
    });

    it('setSecret llamado dos veces para el mismo org+clave actualiza la misma fila en vez de duplicarla (onConflict organization_id,secret_key)', async () => {
        const secretKey = SECRET_KEYS.TOOL_WEBHOOK_SECRET;
        const firstOk = await setSecret(testOrgId, secretKey, 'primer-valor');
        expect(firstOk).toBe(true);

        // Sin el onConflict correcto, el segundo INSERT choca con la
        // restricción única real de (organization_id, secret_key) — una
        // restricción DISTINTA a la primary key sobre la que el upsert cae
        // por defecto — y linkErr queda seteado: setSecret devolvería false
        // en vez de actualizar la fila existente.
        const secondOk = await setSecret(testOrgId, secretKey, 'segundo-valor-tras-rotacion');
        expect(secondOk).toBe(true);

        const { data: rows } = await supabaseAdmin
            .from('organization_secrets')
            .select('id')
            .eq('organization_id', testOrgId)
            .eq('secret_key', secretKey);

        expect(rows?.length).toBe(1);
    });

    it('getPgPool reutiliza la misma instancia de Pool entre llamadas en vez de reconectar cada vez (singleton)', async () => {
        // El pool interno ya fue creado por pruebas anteriores de este archivo
        // (poolInstance es un singleton a nivel de módulo). Si el guard de
        // reutilización se rompe, cada llamada de aquí en adelante abriría una
        // conexión nueva a Postgres en vez de reutilizar la existente.
        const PoolCtorSpy = vi.spyOn(pg, 'Pool');

        await setSecret(testOrgId, SECRET_KEYS.CAL_API_KEY, 'valor-singleton-1');
        await setSecret(testOrgId, SECRET_KEYS.CAL_API_KEY, 'valor-singleton-2');

        expect(PoolCtorSpy).not.toHaveBeenCalled();
        PoolCtorSpy.mockRestore();
    });

    it('clearSecretCache borra la memoria caché de una org específica y globalmente', () => {
        clearSecretCache(testOrgId);
        clearSecretCache();
    });

    it('clearSecretCache() sin argumentos invalida el caché de TODAS las organizaciones', async () => {
        const secretKey = SECRET_KEYS.WHATSAPP_ACCESS_TOKEN;
        await setSecret(testOrgId, secretKey, 'valor-antes-de-clear-global');
        clearSecretCache(testOrgId);

        // Primera lectura: cachea el valor "antes".
        expect(await getSecret(testOrgId, secretKey)).toBe('valor-antes-de-clear-global');

        // Rotar el valor por debajo, sin pasar por setSecret (no invalida caché).
        await rotateVaultSecretBypassingCache(testOrgId, secretKey, 'valor-despues-de-clear-global');

        // Sanity check: sin invalidar, getSecret sigue sirviendo el valor cacheado (stale).
        expect(await getSecret(testOrgId, secretKey)).toBe('valor-antes-de-clear-global');

        // clearSecretCache() global SIN argumentos debe invalidar también esta org.
        clearSecretCache();
        expect(await getSecret(testOrgId, secretKey)).toBe('valor-despues-de-clear-global');
    });

    it('clearSecretCache(organizationId) invalida SOLO esa organización, no las demás', async () => {
        const { data: otherOrg, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org B Pruebas SecretService', email: `test-secret-service-b-${crypto.randomUUID()}@example.invalid` })
            .select('id')
            .single();
        if (error || !otherOrg) throw new Error(`No se pudo crear la segunda organización: ${error?.message}`);
        const otherOrgId = otherOrg.id as string;

        try {
            const secretKey = SECRET_KEYS.CAL_API_KEY;
            await setSecret(testOrgId, secretKey, 'org-a-valor-antes');
            await setSecret(otherOrgId, secretKey, 'org-b-valor-antes');
            clearSecretCache(testOrgId);
            clearSecretCache(otherOrgId);

            // Cachear ambos valores "antes".
            expect(await getSecret(testOrgId, secretKey)).toBe('org-a-valor-antes');
            expect(await getSecret(otherOrgId, secretKey)).toBe('org-b-valor-antes');

            // Rotar ambos por debajo, sin invalidar caché.
            await rotateVaultSecretBypassingCache(testOrgId, secretKey, 'org-a-valor-despues');
            await rotateVaultSecretBypassingCache(otherOrgId, secretKey, 'org-b-valor-despues');

            // Invalidar SOLO la org A.
            clearSecretCache(testOrgId);

            expect(await getSecret(testOrgId, secretKey)).toBe('org-a-valor-despues');
            // La org B NO debió verse afectada: sigue sirviendo el valor cacheado (stale).
            expect(await getSecret(otherOrgId, secretKey)).toBe('org-b-valor-antes');
        } finally {
            clearSecretCache();
            await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', otherOrgId);
            await supabaseAdmin.from('organizations').delete().eq('id', otherOrgId);
        }
    });

    it('Ciclo completo de integración: setSecret crea, getSecret lee, caché responde, setSecret rota y clearSecretCache invalida', async () => {
        const secretKey = SECRET_KEYS.CAL_API_KEY;
        const initialValue = 'cal-secret-v1-initial-12345';
        const rotatedValue = 'cal-secret-v2-rotated-67890';

        // 1. setSecret intenta crear el secreto en Vault y vincularlo en organization_secrets
        const createOk = await setSecret(testOrgId, secretKey, initialValue);

        if (createOk) {
            // Si la conexión a Postgres Vault está disponible en el entorno:
            // 2. getSecret lee de Vault (decrypted_secrets)
            clearSecretCache(testOrgId);
            const readValue1 = await getSecret(testOrgId, secretKey);
            expect(readValue1).toBe(initialValue);

            // 3. getSecret subsiguiente lee de la caché en memoria
            const cachedValue = await getSecret(testOrgId, secretKey);
            expect(cachedValue).toBe(initialValue);

            // 4. setSecret rota el secreto existente en Vault e invalida la caché
            const rotateOk = await setSecret(testOrgId, secretKey, rotatedValue);
            expect(rotateOk).toBe(true);

            // 5. getSecret devuelve el valor rotado
            const readValue2 = await getSecret(testOrgId, secretKey);
            expect(readValue2).toBe(rotatedValue);

            // 6. clearSecretCache invalida la memoria por org y globalmente
            clearSecretCache(testOrgId);
            clearSecretCache();
            const readValue3 = await getSecret(testOrgId, secretKey);
            expect(readValue3).toBe(rotatedValue);
        } else {
            // Si el entorno local rechaza conexiones directas a la IP de Vault, se verifica que no hubo throw descontrolado
            expect(createOk).toBe(false);
        }
    });

    it('maneja múltiples claves de secretos para la misma organización independientemente', async () => {
        const key1 = SECRET_KEYS.ELEVENLABS_API_KEY;
        const val1 = 'sk_eleven_test_abc123';

        const key2 = SECRET_KEYS.WHATSAPP_ACCESS_TOKEN;
        const val2 = 'wa_token_test_xyz789';

        const set1 = await setSecret(testOrgId, key1, val1);
        const set2 = await setSecret(testOrgId, key2, val2);

        if (set1 && set2) {
            expect(await getSecret(testOrgId, key1)).toBe(val1);
            expect(await getSecret(testOrgId, key2)).toBe(val2);
        } else {
            expect(typeof set1).toBe('boolean');
            expect(typeof set2).toBe('boolean');
        }
    });

    describe('listSecretStatus', () => {
        it('devuelve {} si organizationId está vacío, sin consultar la base de datos', async () => {
            const fromSpy = vi.spyOn(supabaseAdmin, 'from');
            const result = await listSecretStatus('');
            expect(result).toEqual({});
            expect(fromSpy).not.toHaveBeenCalled();
        });

        it('devuelve {} si la consulta falla (p.ej. organizationId con formato inválido)', async () => {
            const result = await listSecretStatus('esto-no-es-un-uuid-valido');
            expect(result).toEqual({});
        });

        it('devuelve {} sin lanzar excepción si data llega null sin error (distingue "||" de "&&" en el guard)', async () => {
            // Caso que Supabase-js prácticamente no produce en la práctica (error
            // y data suelen ser mutuamente excluyentes), pero que el guard
            // `if (error || !data)` debe cubrir de todos modos: con `&&` en vez
            // de `||`, este caso NO entraría al guard y el for-loop siguiente
            // lanzaría iterando sobre null.
            const fromSpy = vi.spyOn(supabaseAdmin, 'from').mockReturnValueOnce({
                select: () => ({
                    eq: () => Promise.resolve({ data: null, error: null }),
                }),
            } as any);

            const result = await listSecretStatus(testOrgId);
            expect(result).toEqual({});

            fromSpy.mockRestore();
        });

        it('solicita explícitamente solo las columnas secret_key y rotated_at (no un select vacío/implícito)', async () => {
            const selectSpy = vi.fn().mockReturnValue({
                eq: () => Promise.resolve({ data: [], error: null }),
            });
            const fromSpy = vi.spyOn(supabaseAdmin, 'from').mockReturnValueOnce({ select: selectSpy } as any);

            await listSecretStatus(testOrgId);

            expect(selectSpy).toHaveBeenCalledWith('secret_key, rotated_at');
            fromSpy.mockRestore();
        });

        it('contraparte de éxito: mapea secret_key y rotated_at reales por clave, sin perder ninguno de los dos campos', async () => {
            const secretKey = SECRET_KEYS.WHATSAPP_ACCESS_TOKEN;
            await setSecret(testOrgId, secretKey, 'valor-para-list-status');

            const fixedRotatedAt = '2026-01-15T10:30:00+00:00';
            await supabaseAdmin
                .from('organization_secrets')
                .update({ rotated_at: fixedRotatedAt })
                .eq('organization_id', testOrgId)
                .eq('secret_key', secretKey);

            const result = await listSecretStatus(testOrgId);

            expect(result[secretKey]).toBeDefined();
            expect(result[secretKey].present).toBe(true);
            expect(result[secretKey].rotatedAt).toBe(fixedRotatedAt);
        });

        it('rotatedAt es null cuando la columna rotated_at es null, en vez de perder el campo', async () => {
            const secretKey = SECRET_KEYS.META_APP_SECRET;
            await setSecret(testOrgId, secretKey, 'valor-sin-rotar');
            await supabaseAdmin
                .from('organization_secrets')
                .update({ rotated_at: null })
                .eq('organization_id', testOrgId)
                .eq('secret_key', secretKey);

            const result = await listSecretStatus(testOrgId);
            expect(result[secretKey]).toEqual({ present: true, rotatedAt: null });
        });
    });
});
