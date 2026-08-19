import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import supabasePlugin from '../src/plugins/supabase.js';
import adminPermissionsRoutes from '../src/routes/admin/permissions.js';
import { PERMISSION_KEYS, ALL_PERMISSION_KEYS } from '../src/types/permission-keys.js';
import { ORGANIZATION_ROLES } from '../src/types/organization-roles.js';

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(adminPermissionsRoutes);
    await app.ready();
    return app;
}

const ADMIN_HEADERS = { 'x-platform-admin': 'true' };

describe('routes/admin/permissions.ts — consola de permisos del superadmin (RBAC FASE D)', () => {
    let app: FastifyInstance;
    let ownerUserId: string;
    let orgId: string;

    beforeAll(async () => {
        app = await buildTestApp();

        const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
            email: `test-admin-perms-owner-${crypto.randomUUID()}@example.invalid`,
            password: `Pw-${crypto.randomBytes(16).toString('hex')}`,
            email_confirm: true,
        });
        if (createErr || !created.user) throw new Error(`No se pudo crear el owner de prueba: ${createErr?.message}`);
        ownerUserId = created.user.id;

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Admin Permissions Test Org',
            p_email: `admin-perms-test-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: ownerUserId,
        });
        if (error || !org) throw new Error(`Setup falló creando organización: ${error?.message}`);
        orgId = org.id;
    });

    afterAll(async () => {
        await app.close();
        await supabaseAdmin.from('organization_role_permissions').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await supabaseAdmin.auth.admin.deleteUser(ownerUserId);
    });

    it('GET /api/admin/permissions expone el catálogo completo, con el contenido y orden reales de la base', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/admin/permissions', headers: ADMIN_HEADERS });
        expect(res.statusCode).toBe(200);
        const body = res.json();

        expect(body.data.permissions.length).toBeGreaterThanOrEqual(15);
        // Fija el contenido exacto de una fila conocida — mata mutantes en
        // .select('key, name, description, category, is_sensitive, sort_order').
        const viewCosts = body.data.permissions.find((p: any) => p.key === PERMISSION_KEYS.VIEW_COSTS);
        expect(viewCosts).toMatchObject({ key: 'view_costs', category: 'finanzas', is_sensitive: true });
        expect(typeof viewCosts.name).toBe('string');
        expect(viewCosts.name.length).toBeGreaterThan(0);
        // Orden real por sort_order ascendente — mata mutantes en .order(...).
        for (let i = 1; i < body.data.permissions.length; i++) {
            expect(body.data.permissions[i].sort_order).toBeGreaterThanOrEqual(body.data.permissions[i - 1].sort_order);
        }

        // Set exacto (no solo "contiene") — mata mutantes en el inicializador
        // `defaultsByRole[role] = []` y en el push condicionado por `enabled`.
        expect([...body.data.roleDefaults.owner].sort()).toEqual([...ALL_PERMISSION_KEYS].sort());
        expect([...body.data.roleDefaults.viewer].sort()).toEqual([PERMISSION_KEYS.VIEW_CONTACTS, PERMISSION_KEYS.VIEW_CONVERSATIONS].sort());
        expect(body.data.roleDefaults.member).toContain(PERMISSION_KEYS.EDIT_CONTACTS);
        expect(body.data.roleDefaults.member).not.toContain(PERMISSION_KEYS.MANAGE_USERS);
    });

    it('GET /api/admin/organizations/:id/permissions: sin overrides, el mapa efectivo es el default (contenido exacto)', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/api/admin/organizations/${orgId}/permissions`,
            headers: ADMIN_HEADERS,
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.success).toBe(true);
        expect(body.data.organizationId).toBe(orgId);

        const viewerRow = body.data.roles.viewer.find((r: any) => r.permissionKey === PERMISSION_KEYS.VIEW_COSTS);
        expect(viewerRow).toMatchObject({
            permissionKey: PERMISSION_KEYS.VIEW_COSTS,
            category: 'finanzas',
            isSensitive: true,
            defaultEnabled: false,
            effective: false,
            origin: 'default',
            override: null,
        });

        // member SÍ tiene view_contacts por default — confirma que
        // defaultEnabled refleja role_permissions real, no solo `false`.
        const memberViewContacts = body.data.roles.member.find((r: any) => r.permissionKey === PERMISSION_KEYS.VIEW_CONTACTS);
        expect(memberViewContacts.defaultEnabled).toBe(true);
        expect(memberViewContacts.effective).toBe(true);

        // Invariante de owner (línea 116-117 de admin/permissions.ts): SOLO
        // owner+manage_users u owner+change_plan son 'owner_invariant'. Un
        // admin con manage_users por default NO lo es (queda 'default'), y
        // el owner con un permiso cualquiera tampoco.
        const ownerManageUsers = body.data.roles.owner.find((r: any) => r.permissionKey === PERMISSION_KEYS.MANAGE_USERS);
        expect(ownerManageUsers.origin).toBe('owner_invariant');
        const ownerChangePlan = body.data.roles.owner.find((r: any) => r.permissionKey === PERMISSION_KEYS.CHANGE_PLAN);
        expect(ownerChangePlan.origin).toBe('owner_invariant');
        const ownerViewContacts = body.data.roles.owner.find((r: any) => r.permissionKey === PERMISSION_KEYS.VIEW_CONTACTS);
        expect(ownerViewContacts.origin).toBe('default');
        const adminManageUsers = body.data.roles.admin.find((r: any) => r.permissionKey === PERMISSION_KEYS.MANAGE_USERS);
        expect(adminManageUsers.origin).toBe('default');
        expect(adminManageUsers.effective).toBe(true); // admin lo tiene por default, pero NO por invariante

        // roles.viewer trae TODOS los permisos del catálogo, no un subconjunto —
        // mata mutantes en `(permissions ?? []).map(...)`.
        expect(body.data.roles.viewer.length).toBe(body.data.roles.owner.length);
        expect(body.data.roles.viewer.length).toBeGreaterThanOrEqual(15);
    });

    it('PATCH: reason es obligatorio', async () => {
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/admin/organizations/${orgId}/permissions`,
            headers: ADMIN_HEADERS,
            payload: { role: 'viewer', permission_key: PERMISSION_KEYS.VIEW_COSTS, enabled: true },
        });
        expect(res.statusCode).toBe(400);
    });

    it('PATCH: un permiso is_sensitive sin "confirm: true" se rechaza', async () => {
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/admin/organizations/${orgId}/permissions`,
            headers: ADMIN_HEADERS,
            payload: { role: 'viewer', permission_key: PERMISSION_KEYS.VIEW_COSTS, enabled: true, reason: 'Prueba' },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('CONFIRMATION_REQUIRED');
    });

    it('PATCH: el "reason" se guarda recortado (trim) de espacios en blanco', async () => {
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/admin/organizations/${orgId}/permissions`,
            headers: ADMIN_HEADERS,
            payload: { role: 'admin', permission_key: PERMISSION_KEYS.EXPORT_DATA, enabled: true, reason: '   Prueba con espacios   ', confirm: true },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ success: true });

        const { data } = await supabaseAdmin
            .from('organization_role_permissions')
            .select('reason')
            .eq('organization_id', orgId)
            .eq('role', 'admin')
            .eq('permission_key', PERMISSION_KEYS.EXPORT_DATA)
            .single();
        expect(data?.reason).toBe('Prueba con espacios');
    });

    it('contraparte de éxito: un override del superadmin cambia el permiso efectivo, y al expirar vuelve al default', async () => {
        const grantRes = await app.inject({
            method: 'PATCH',
            url: `/api/admin/organizations/${orgId}/permissions`,
            headers: ADMIN_HEADERS,
            payload: { role: 'viewer', permission_key: PERMISSION_KEYS.VIEW_COSTS, enabled: true, reason: 'Prueba de override', confirm: true },
        });
        expect(grantRes.statusCode).toBe(200);

        const afterGrant = await app.inject({
            method: 'GET',
            url: `/api/admin/organizations/${orgId}/permissions`,
            headers: ADMIN_HEADERS,
        });
        const viewerRowGranted = afterGrant.json().data.roles.viewer.find((r: any) => r.permissionKey === PERMISSION_KEYS.VIEW_COSTS);
        expect(viewerRowGranted.effective).toBe(true);
        expect(viewerRowGranted.origin).toBe('override_grant');

        // Simula expiración (sin esperar al cron de expire_role_permission_overrides):
        // se pone expires_at en el pasado directamente.
        await supabaseAdmin
            .from('organization_role_permissions')
            .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
            .eq('organization_id', orgId)
            .eq('role', 'viewer')
            .eq('permission_key', PERMISSION_KEYS.VIEW_COSTS);

        const afterExpiry = await app.inject({
            method: 'GET',
            url: `/api/admin/organizations/${orgId}/permissions`,
            headers: ADMIN_HEADERS,
        });
        const viewerRowExpired = afterExpiry.json().data.roles.viewer.find((r: any) => r.permissionKey === PERMISSION_KEYS.VIEW_COSTS);
        expect(viewerRowExpired.effective).toBe(false);
        expect(viewerRowExpired.origin).toBe('default');
    });

    it('revocar manage_users al owner se rechaza (invariante de owner)', async () => {
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/admin/organizations/${orgId}/permissions`,
            headers: ADMIN_HEADERS,
            payload: { role: 'owner', permission_key: PERMISSION_KEYS.MANAGE_USERS, enabled: false, reason: 'Intento de revocar', confirm: true },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('OWNER_INVARIANT');

        const mapRes = await app.inject({
            method: 'GET',
            url: `/api/admin/organizations/${orgId}/permissions`,
            headers: ADMIN_HEADERS,
        });
        const ownerRow = mapRes.json().data.roles.owner.find((r: any) => r.permissionKey === PERMISSION_KEYS.MANAGE_USERS);
        expect(ownerRow.effective).toBe(true);
        expect(ownerRow.origin).toBe('owner_invariant');
    });

    it('GET /audit lista los cambios registrados', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/api/admin/organizations/${orgId}/permissions/audit`,
            headers: ADMIN_HEADERS,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().data.some((row: any) => row.permission_key === PERMISSION_KEYS.VIEW_COSTS)).toBe(true);
    });

    describe('nivel support (platform_admins.level) — solo lectura', () => {
        let supportUserId: string;
        let supportJwt: string;

        beforeAll(async () => {
            const email = `test-support-admin-${crypto.randomUUID()}@example.invalid`;
            const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;
            const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
                email,
                password,
                email_confirm: true,
                app_metadata: { is_platform_admin: true },
            });
            if (error || !created.user) throw new Error(`No se pudo crear el usuario support: ${error?.message}`);
            supportUserId = created.user.id;

            const { error: levelErr } = await supabaseAdmin.from('platform_admins').insert({ user_id: supportUserId, level: 'support' });
            if (levelErr) throw new Error(`No se pudo insertar platform_admins: ${levelErr.message}`);

            const { createClient } = await import('@supabase/supabase-js');
            const { validateEnv } = await import('../src/config/env.js');
            const env = validateEnv();
            const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
            const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
            if (signInErr || !session.session) throw new Error(`No se pudo iniciar sesión support: ${signInErr?.message}`);
            supportJwt = session.session.access_token;
        });

        afterAll(async () => {
            await supabaseAdmin.from('platform_admins').delete().eq('user_id', supportUserId);
            await supabaseAdmin.auth.admin.deleteUser(supportUserId);
        });

        it('un admin de nivel support puede LEER el mapa de permisos', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/admin/organizations/${orgId}/permissions`,
                headers: { authorization: `Bearer ${supportJwt}` },
            });
            expect(res.statusCode).toBe(200);
        });

        it('un admin de nivel support recibe 403 al intentar ESCRIBIR un override', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/organizations/${orgId}/permissions`,
                headers: { authorization: `Bearer ${supportJwt}` },
                payload: { role: 'viewer', permission_key: PERMISSION_KEYS.VIEW_CONTACTS, enabled: false, reason: 'Intento de support' },
            });
            expect(res.statusCode).toBe(403);
        });
    });
});
