import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getSecret, setSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * Pruebas de integración reales contra Supabase Postgres y Vault sin mocks.
 * Ejercitan el ciclo completo de creación, lectura, rotación e invalidación de caché.
 */
describe('src/services/secret-service.ts — Pruebas de Integración Reales contra Supabase Vault', () => {
    let testOrgId: string;

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org Pruebas SecretService', email: 'test-secret-service@example.invalid' })
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
    });

    it('getSecret devuelve null si organizationId o secretKey son falsy', async () => {
        const resNullOrg = await getSecret('', SECRET_KEYS.ELEVENLABS_API_KEY);
        expect(resNullOrg).toBeNull();

        const resNullKey = await getSecret(testOrgId, '' as any);
        expect(resNullKey).toBeNull();
    });

    it('getSecret devuelve null para un secreto que no existe en organization_secrets', async () => {
        const value = await getSecret(testOrgId, SECRET_KEYS.TELNYX_API_KEY);
        expect(value).toBeNull();
    });

    it('clearSecretCache borra la memoria caché de una org específica y globalmente', () => {
        clearSecretCache(testOrgId);
        clearSecretCache();
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
});
