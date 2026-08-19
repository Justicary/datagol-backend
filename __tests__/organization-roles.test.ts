import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ALL_ORGANIZATION_ROLES } from '../src/types/organization-roles.js';
import { PERMISSION_CATEGORIES } from '../src/types/permission-keys.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

const DIAG_PERMISSION_KEY = 'diag_test_organization_roles';

/**
 * src/types/organization-roles.ts es la única fuente de verdad para los 4
 * roles de negocio. `organization_members.role` no tiene CHECK constraint
 * propio (ver comentario del módulo), así que esta prueba verifica el
 * CHECK compartido de `role_permissions.role` — inserta una fila
 * `permissions` desechable (necesaria por la FK de `role_permissions.
 * permission_key`) y prueba cada rol contra ella.
 */
describe('src/types/organization-roles.ts — sincronizado con el CHECK constraint real de role_permissions', () => {
    beforeAll(async () => {
        const { error } = await supabaseAdmin.from('permissions').insert({
            key: DIAG_PERMISSION_KEY,
            name: 'Diagnóstico (organization-roles.test.ts)',
            category: PERMISSION_CATEGORIES.DATOS,
        });
        if (error) {
            throw new Error(`No se pudo crear el permiso desechable de la prueba: ${error.message}`);
        }
    });

    afterAll(async () => {
        // on delete cascade en role_permissions.permission_key limpia cualquier
        // fila de rol que haya quedado sin borrar por un fallo a mitad de prueba.
        await supabaseAdmin.from('permissions').delete().eq('key', DIAG_PERMISSION_KEY);
    });

    it.each(ALL_ORGANIZATION_ROLES)('el rol "%s" es aceptado por role_permissions_role_check', async (role) => {
        const { error } = await supabaseAdmin
            .from('role_permissions')
            .insert({ role, permission_key: DIAG_PERMISSION_KEY });

        expect(error?.code).not.toBe('23514');

        await supabaseAdmin
            .from('role_permissions')
            .delete()
            .eq('role', role)
            .eq('permission_key', DIAG_PERMISSION_KEY);
    });
});
