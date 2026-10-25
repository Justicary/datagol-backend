import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin, createSupabaseUserClient } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import {
    getPermissionsForMember,
    getPermissionsForUser,
    clearPermissionsCache,
} from '../src/services/permission-service.js';
import { PERMISSION_KEYS } from '../src/types/permission-keys.js';

const env = validateEnv();

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-member-perms-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
    });
    if (createErr || !created.user) {
        throw new Error(`No se pudo crear usuario de prueba: ${createErr?.message}`);
    }

    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) {
        throw new Error(`No se pudo iniciar sesión de prueba: ${signInErr?.message}`);
    }

    return { userId: created.user.id, jwt: session.session.access_token };
}

describe('Fase T3 — getPermissionsForMember y aislamiento de member_permissions_in_org', () => {
    let orgId: string;
    let ownerUser: TestUser;
    let adminUser: TestUser;
    let viewerUser: TestUser;
    let outsiderUser: TestUser;

    beforeAll(async () => {
        ownerUser = await createTestUserWithJwt();
        adminUser = await createTestUserWithJwt();
        viewerUser = await createTestUserWithJwt();
        outsiderUser = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Org Test Member Perms',
            p_email: `org-member-perms-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: ownerUser.userId,
        });
        if (error || !org) {
            throw new Error(`No se pudo crear organización de prueba: ${error?.message}`);
        }
        orgId = org.id;

        await supabaseAdmin.from('organizations').update({ plan_key: 'pro' }).eq('id', orgId);

        await supabaseAdmin.from('organization_members').insert([
            { organization_id: orgId, user_id: adminUser.userId, role: 'admin' },
            { organization_id: orgId, user_id: viewerUser.userId, role: 'viewer' },
        ]);
    });

    afterAll(async () => {
        if (orgId) {
            await supabaseAdmin.from('organization_role_permissions').delete().eq('organization_id', orgId);
            await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        }
        for (const u of [ownerUser, adminUser, viewerUser, outsiderUser]) {
            if (u?.userId) {
                await supabaseAdmin.auth.admin.deleteUser(u.userId);
            }
        }
        clearPermissionsCache();
    });

    beforeEach(async () => {
        vi.restoreAllMocks();
        clearPermissionsCache();
        if (orgId) {
            await supabaseAdmin.from('organization_role_permissions').delete().eq('organization_id', orgId);
        }
    });

    it('RECHAZO: un cliente con rol authenticated NO puede ejecutar member_permissions_in_org directamente', async () => {
        const userClient = createSupabaseUserClient(adminUser.jwt);
        const { data, error } = await userClient.rpc('member_permissions_in_org', {
            p_org_id: orgId,
            p_user_id: ownerUser.userId,
        });

        expect(error).not.toBeNull();
        expect(data).toBeNull();
    });

    it('ÉXITO (contraparte): service_role vía getPermissionsForMember obtiene exactamente el mismo conjunto que getPermissionsForUser para owner, admin, viewer y outsider', async () => {
        for (const user of [ownerUser, adminUser, viewerUser, outsiderUser]) {
            clearPermissionsCache();
            const viaJwt = await getPermissionsForUser(orgId, user.userId, user.jwt);
            clearPermissionsCache();
            const viaMemberRpc = await getPermissionsForMember(orgId, user.userId);

            expect(Array.from(viaMemberRpc).sort()).toEqual(Array.from(viaJwt).sort());
        }

        const adminPerms = await getPermissionsForMember(orgId, adminUser.userId);
        expect(adminPerms.has(PERMISSION_KEYS.USE_NL_REPORTS)).toBe(true);

        const viewerPerms = await getPermissionsForMember(orgId, viewerUser.userId);
        expect(viewerPerms.has(PERMISSION_KEYS.USE_NL_REPORTS)).toBe(false);

        const outsiderPerms = await getPermissionsForMember(orgId, outsiderUser.userId);
        expect(outsiderPerms.size).toBe(0);
    });

    it('respeta overrides activos en organization_role_permissions e ignora overrides expirados', async () => {
        // 1. Override activo que revoca use_nl_reports al rol admin
        const { error: err1 } = await supabaseAdmin.from('organization_role_permissions').upsert(
            {
                organization_id: orgId,
                role: 'admin',
                permission_key: PERMISSION_KEYS.USE_NL_REPORTS,
                enabled: false,
                reason: 'Prueba de revocación para Telegram',
                expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
            { onConflict: 'organization_id,role,permission_key' }
        );
        expect(err1).toBeNull();
        clearPermissionsCache(orgId);

        const revokedPerms = await getPermissionsForMember(orgId, adminUser.userId);
        expect(revokedPerms.has(PERMISSION_KEYS.USE_NL_REPORTS)).toBe(false);

        // 2. Override expirado: debe volver al default del rol admin (use_nl_reports = true)
        const { error: err2 } = await supabaseAdmin.from('organization_role_permissions').upsert(
            {
                organization_id: orgId,
                role: 'admin',
                permission_key: PERMISSION_KEYS.USE_NL_REPORTS,
                enabled: false,
                reason: 'Override ya vencido',
                expires_at: new Date(Date.now() - 60_000).toISOString(),
            },
            { onConflict: 'organization_id,role,permission_key' }
        );
        expect(err2).toBeNull();
        clearPermissionsCache(orgId);

        const restoredPerms = await getPermissionsForMember(orgId, adminUser.userId);
        expect(restoredPerms.has(PERMISSION_KEYS.USE_NL_REPORTS)).toBe(true);
    });

    it('preserva el invariante de owner (manage_users y change_plan nunca se pierden aunque exista override en falso)', async () => {
        await supabaseAdmin.from('organization_role_permissions').upsert([
            {
                organization_id: orgId,
                role: 'owner',
                permission_key: PERMISSION_KEYS.MANAGE_USERS,
                enabled: false,
                reason: 'Intento de quitar manage_users al owner',
            },
            {
                organization_id: orgId,
                role: 'owner',
                permission_key: PERMISSION_KEYS.CHANGE_PLAN,
                enabled: false,
                reason: 'Intento de quitar change_plan al owner',
            },
        ]);
        clearPermissionsCache(orgId);

        const ownerPerms = await getPermissionsForMember(orgId, ownerUser.userId);
        expect(ownerPerms.has(PERMISSION_KEYS.MANAGE_USERS)).toBe(true);
        expect(ownerPerms.has(PERMISSION_KEYS.CHANGE_PLAN)).toBe(true);
    });

    it('devuelve conjunto vacío si organizationId o userId están vacíos o si el RPC falla', async () => {
        expect((await getPermissionsForMember('', adminUser.userId)).size).toBe(0);
        expect((await getPermissionsForMember(orgId, '')).size).toBe(0);

        vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValueOnce({
            data: null,
            error: { message: 'DB error', details: '', hint: '', code: '500' } as any,
            count: null,
            status: 500,
            statusText: 'Internal Server Error',
        });

        const fallbackPerms = await getPermissionsForMember(orgId, adminUser.userId);
        expect(fallbackPerms.size).toBe(0);
    });
});
