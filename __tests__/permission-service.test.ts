import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import {
    getPermissionsForUser,
    hasPermission,
    clearPermissionsCache,
    omitProtectedTranscriptFields,
    omitProtectedTranscriptFieldsFromList,
} from '../src/services/permission-service.js';
import { PERMISSION_KEYS } from '../src/types/permission-keys.js';
import { ORGANIZATION_ROLES } from '../src/types/organization-roles.js';

const env = validateEnv();

interface TestUser {
    userId: string;
    jwt: string;
}

// Mismo patrón que __tests__/contacts-crm.test.ts: JWT real vía signInWithPassword.
async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-perm-svc-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createErr || !created.user) throw new Error(`No se pudo crear el usuario de prueba: ${createErr?.message}`);

    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) throw new Error(`No se pudo iniciar sesión de prueba: ${signInErr?.message}`);

    return { userId: created.user.id, jwt: session.session.access_token };
}

async function deleteTestUser(userId: string): Promise<void> {
    await supabaseAdmin.auth.admin.deleteUser(userId);
}

describe('services/permission-service.ts', () => {
    let owner: TestUser;
    let member: TestUser;
    let viewer: TestUser;
    let outsider: TestUser;
    let orgId: string;

    beforeAll(async () => {
        owner = await createTestUserWithJwt();
        member = await createTestUserWithJwt();
        viewer = await createTestUserWithJwt();
        outsider = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Permission Service Test Org',
            p_email: `perm-svc-test-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`Setup falló creando organización: ${error?.message}`);
        orgId = org.id;

        // El plan starter (default) solo trae 2 asientos (owner + 1); esta
        // prueba necesita 4 miembros simultáneos, así que se sube el plan
        // ANTES de insertar — enforce_seat_limit (migración 45) lo exige.
        await supabaseAdmin.from('organizations').update({ plan_key: 'elite' }).eq('id', orgId);

        const { error: memberErr } = await supabaseAdmin
            .from('organization_members')
            .insert([
                { organization_id: orgId, user_id: member.userId, role: ORGANIZATION_ROLES.MEMBER },
                { organization_id: orgId, user_id: viewer.userId, role: ORGANIZATION_ROLES.VIEWER },
            ]);
        if (memberErr) throw new Error(`Setup falló agregando miembros: ${memberErr.message}`);
    });

    afterAll(async () => {
        await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await deleteTestUser(owner.userId);
        await deleteTestUser(member.userId);
        await deleteTestUser(viewer.userId);
        await deleteTestUser(outsider.userId);
    });

    it('el owner recibe el catálogo completo de permisos', async () => {
        const permissions = await getPermissionsForUser(orgId, owner.userId, owner.jwt);
        expect(hasPermission(permissions, PERMISSION_KEYS.MANAGE_USERS)).toBe(true);
        expect(hasPermission(permissions, PERMISSION_KEYS.CHANGE_PLAN)).toBe(true);
        expect(hasPermission(permissions, PERMISSION_KEYS.VIEW_TRANSCRIPTS)).toBe(true);
    });

    it('un member recibe el subconjunto operativo, sin permisos financieros', async () => {
        const permissions = await getPermissionsForUser(orgId, member.userId, member.jwt);
        expect(hasPermission(permissions, PERMISSION_KEYS.VIEW_TRANSCRIPTS)).toBe(true);
        expect(hasPermission(permissions, PERMISSION_KEYS.EDIT_CONTACTS)).toBe(true);
        expect(hasPermission(permissions, PERMISSION_KEYS.VIEW_COSTS)).toBe(false);
        expect(hasPermission(permissions, PERMISSION_KEYS.MANAGE_USERS)).toBe(false);
    });

    it('un viewer recibe solo lectura, sin transcripciones', async () => {
        const permissions = await getPermissionsForUser(orgId, viewer.userId, viewer.jwt);
        expect(hasPermission(permissions, PERMISSION_KEYS.VIEW_CONTACTS)).toBe(true);
        expect(hasPermission(permissions, PERMISSION_KEYS.VIEW_TRANSCRIPTS)).toBe(false);
        expect(hasPermission(permissions, PERMISSION_KEYS.EDIT_CONTACTS)).toBe(false);
    });

    it('un usuario que no es miembro recibe el conjunto vacío', async () => {
        const permissions = await getPermissionsForUser(orgId, outsider.userId, outsider.jwt);
        expect(permissions.size).toBe(0);
    });

    it('clearPermissionsCache invalida el caché tras un cambio de rol', async () => {
        // Primera resolución: cachea el subconjunto de member.
        const before = await getPermissionsForUser(orgId, member.userId, member.jwt);
        expect(hasPermission(before, PERMISSION_KEYS.MANAGE_USERS)).toBe(false);

        await supabaseAdmin
            .from('organization_members')
            .update({ role: ORGANIZATION_ROLES.ADMIN })
            .eq('organization_id', orgId)
            .eq('user_id', member.userId);

        // Sin invalidar: el caché (TTL 30s) sigue devolviendo el rol viejo.
        const stillCached = await getPermissionsForUser(orgId, member.userId, member.jwt);
        expect(hasPermission(stillCached, PERMISSION_KEYS.MANAGE_USERS)).toBe(false);

        clearPermissionsCache(orgId, member.userId);

        const afterInvalidation = await getPermissionsForUser(orgId, member.userId, member.jwt);
        expect(hasPermission(afterInvalidation, PERMISSION_KEYS.MANAGE_USERS)).toBe(true);

        // Revertir para no afectar otras pruebas de este archivo.
        await supabaseAdmin
            .from('organization_members')
            .update({ role: ORGANIZATION_ROLES.MEMBER })
            .eq('organization_id', orgId)
            .eq('user_id', member.userId);
        clearPermissionsCache(orgId, member.userId);
    });

    it('omitProtectedTranscriptFields borra transcript/summary, no los anula', () => {
        const record = { id: 'abc', transcript: 'hola', summary: 'resumen', other: 1 };

        const redacted = omitProtectedTranscriptFields(record, false);
        expect('transcript' in redacted).toBe(false);
        expect('summary' in redacted).toBe(false);
        expect(redacted.other).toBe(1);

        const kept = omitProtectedTranscriptFields(record, true);
        expect(kept.transcript).toBe('hola');
        expect(kept.summary).toBe('resumen');
    });

    it('sin organizationId o sin userId, devuelve el conjunto vacío sin llamar a la base', async () => {
        expect((await getPermissionsForUser('', member.userId, member.jwt)).size).toBe(0);
        expect((await getPermissionsForUser(orgId, '', member.jwt)).size).toBe(0);
    });

    it('un JWT inválido (no es una sesión real) deniega por defecto en vez de lanzar', async () => {
        const permissions = await getPermissionsForUser(orgId, member.userId, 'esto-no-es-un-jwt-valido');
        expect(permissions.size).toBe(0);
    });

    it('clearPermissionsCache() sin argumentos invalida TODA la caché (no solo una organización)', async () => {
        await getPermissionsForUser(orgId, member.userId, member.jwt);

        await supabaseAdmin
            .from('organization_members')
            .update({ role: ORGANIZATION_ROLES.ADMIN })
            .eq('organization_id', orgId)
            .eq('user_id', member.userId);

        clearPermissionsCache();

        const afterGlobalClear = await getPermissionsForUser(orgId, member.userId, member.jwt);
        expect(hasPermission(afterGlobalClear, PERMISSION_KEYS.MANAGE_USERS)).toBe(true);

        await supabaseAdmin
            .from('organization_members')
            .update({ role: ORGANIZATION_ROLES.MEMBER })
            .eq('organization_id', orgId)
            .eq('user_id', member.userId);
        clearPermissionsCache();
    });

    it('clearPermissionsCache(organizationId) sin userId invalida a todos los usuarios de esa organización', async () => {
        await getPermissionsForUser(orgId, member.userId, member.jwt);
        await getPermissionsForUser(orgId, viewer.userId, viewer.jwt);

        await supabaseAdmin
            .from('organization_members')
            .update({ role: ORGANIZATION_ROLES.ADMIN })
            .eq('organization_id', orgId)
            .in('user_id', [member.userId, viewer.userId]);

        clearPermissionsCache(orgId);

        const memberAfter = await getPermissionsForUser(orgId, member.userId, member.jwt);
        const viewerAfter = await getPermissionsForUser(orgId, viewer.userId, viewer.jwt);
        expect(hasPermission(memberAfter, PERMISSION_KEYS.MANAGE_USERS)).toBe(true);
        expect(hasPermission(viewerAfter, PERMISSION_KEYS.MANAGE_USERS)).toBe(true);

        await supabaseAdmin
            .from('organization_members')
            .update({ role: ORGANIZATION_ROLES.MEMBER })
            .eq('organization_id', orgId)
            .eq('user_id', member.userId);
        await supabaseAdmin
            .from('organization_members')
            .update({ role: ORGANIZATION_ROLES.VIEWER })
            .eq('organization_id', orgId)
            .eq('user_id', viewer.userId);
        clearPermissionsCache(orgId);
    });

    it('omitProtectedTranscriptFieldsFromList aplica la redacción a cada elemento', () => {
        const records = [
            { id: '1', transcript: 'a', summary: 'a' },
            { id: '2', transcript: 'b', summary: 'b' },
        ];
        const redacted = omitProtectedTranscriptFieldsFromList(records, false);
        expect(redacted.every((r) => !('transcript' in r) && !('summary' in r))).toBe(true);
    });
});
