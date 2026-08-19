import { describe, it, expect } from 'vitest';
import { ALL_PERMISSION_KEYS, ALL_PERMISSION_CATEGORIES } from '../src/types/permission-keys.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

const DIAG_KEY_PREFIX = 'diag_test_permission_category_';

/**
 * `permissions.key` no tiene CHECK constraint (PK de texto libre, mismo
 * criterio documentado en feature-taxonomy.ts para `features.key`) — la
 * migración 45 lo puebla con un INSERT fijo de 15 filas. Lo que se verifica
 * aquí es que PERMISSION_KEYS coincide EXACTAMENTE (en ambas direcciones)
 * con las filas reales de `permissions`, para que un typo o una clave
 * retirada del catálogo no pase inadvertido.
 *
 * `permissions.category` sí tiene CHECK constraint — se verifica por
 * inserción real de una fila desechable por categoría.
 */
describe('src/types/permission-keys.ts — sincronizado con el catálogo real de permissions', () => {
    it('ALL_PERMISSION_KEYS coincide exactamente con las filas de permissions', async () => {
        const { data, error } = await supabaseAdmin.from('permissions').select('key');
        expect(error).toBeNull();

        const realKeys = new Set((data ?? []).map((row) => row.key));
        const moduleKeys = new Set(ALL_PERMISSION_KEYS);

        for (const key of moduleKeys) {
            expect(realKeys.has(key)).toBe(true);
        }
        for (const key of realKeys) {
            expect(moduleKeys.has(key as (typeof ALL_PERMISSION_KEYS)[number])).toBe(true);
        }
    });

    it.each(ALL_PERMISSION_CATEGORIES)('la categoría "%s" es aceptada por permissions_category_check', async (category) => {
        const diagKey = `${DIAG_KEY_PREFIX}${category}`;
        const { error } = await supabaseAdmin
            .from('permissions')
            .insert({ key: diagKey, name: `Diagnóstico (${category})`, category });

        expect(error?.code).not.toBe('23514');

        await supabaseAdmin.from('permissions').delete().eq('key', diagKey);
    });
});
