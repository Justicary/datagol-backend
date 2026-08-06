import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ALL_SECRET_KEYS } from '../src/types/secret-keys.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

const DUMMY_VAULT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * src/types/secret-keys.ts es la única fuente de verdad para las claves de
 * organization_secrets.secret_key. Esta prueba no confía en esa lista por sí
 * misma: inserta cada clave contra la base real y falla si el CHECK
 * constraint la rechaza. Si alguien agrega una clave al módulo sin que la
 * base la permita (o viceversa), esta prueba lo detecta.
 *
 * Usa una organización dedicada y desechable (no una compartida con otros
 * archivos de test) porque organization_secrets tiene restricción única
 * (organization_id, secret_key): reutilizar una organización real que otras
 * pruebas también usan con las mismas claves (p. ej. 1.6.G con
 * whatsapp_access_token) genera una condición de carrera entre archivos de
 * test que vitest ejecuta en paralelo — el delete() de uno puede borrar la
 * fila que el otro acaba de crear.
 */
describe('src/types/secret-keys.ts — sincronizado con el CHECK constraint real de organization_secrets', () => {
    let testOrgId: string;

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Test Org (secret-keys.test.ts)', email: 'test-secret-keys@example.invalid' })
            .select('id')
            .single();
        if (error || !data) {
            throw new Error(`No se pudo crear la organización dedicada de la prueba: ${error?.message}`);
        }
        testOrgId = data.id;
    });

    afterAll(async () => {
        if (testOrgId) {
            await supabaseAdmin.from('organizations').delete().eq('id', testOrgId);
        }
    });

    it.each(ALL_SECRET_KEYS)('la clave "%s" es aceptada por organization_secrets_secret_key_check', async (secretKey) => {
        const { error } = await supabaseAdmin
            .from('organization_secrets')
            .insert({ organization_id: testOrgId, secret_key: secretKey, vault_secret_id: DUMMY_VAULT_ID })
            .select('id')
            .single();

        expect(error?.code).not.toBe('23514');

        await supabaseAdmin
            .from('organization_secrets')
            .delete()
            .eq('organization_id', testOrgId)
            .eq('secret_key', secretKey);
    });
});
