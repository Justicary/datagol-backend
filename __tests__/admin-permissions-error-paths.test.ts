import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import supabasePlugin from '../src/plugins/supabase.js';
import adminPermissionsRoutes from '../src/routes/admin/permissions.js';
import { PERMISSION_KEYS } from '../src/types/permission-keys.js';

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(adminPermissionsRoutes);
    await app.ready();
    return app;
}

const ADMIN_HEADERS = { 'x-platform-admin': 'true' };

function mockFrom(table: string, impl: any) {
    const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
    return vi.spyOn(supabaseAdmin, 'from').mockImplementation((t: string) => (t === table ? impl : originalFrom(t)));
}

describe('routes/admin/permissions.ts — validación y ramas de error', () => {
    let app: FastifyInstance;
    let ownerUserId: string;
    let orgId: string;

    beforeAll(async () => {
        app = await buildTestApp();

        const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
            email: `test-admin-perms-err-${crypto.randomUUID()}@example.invalid`,
            password: `Pw-${crypto.randomBytes(16).toString('hex')}`,
            email_confirm: true,
        });
        if (createErr || !created.user) throw new Error(`No se pudo crear el owner de prueba: ${createErr?.message}`);
        ownerUserId = created.user.id;

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Admin Permissions Error Paths Test Org',
            p_email: `admin-perms-err-test-${crypto.randomUUID()}@example.invalid`,
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

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('GET /api/admin/permissions', () => {
        it('si falla la consulta a permissions, responde 500 con el mensaje real del error', async () => {
            mockFrom('permissions', { select: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'Simulated permissions error' } }) }) });
            const res = await app.inject({ method: 'GET', url: '/api/admin/permissions', headers: ADMIN_HEADERS });
            expect(res.statusCode).toBe(500);
            expect(res.json()).toEqual({ success: false, error: 'Simulated permissions error' });
        });

        it('si falla la consulta a role_permissions, responde 500 con el mensaje real del error', async () => {
            mockFrom('role_permissions', { select: () => Promise.resolve({ data: null, error: { message: 'Simulated role_permissions error' } }) });
            const res = await app.inject({ method: 'GET', url: '/api/admin/permissions', headers: ADMIN_HEADERS });
            expect(res.statusCode).toBe(500);
            expect(res.json()).toEqual({ success: false, error: 'Simulated role_permissions error' });
        });

        it('éxito con permissions=null (sin error) devuelve permissions:[] en vez de fallar', async () => {
            mockFrom('permissions', { select: () => ({ order: () => Promise.resolve({ data: null, error: null }) }) });
            const res = await app.inject({ method: 'GET', url: '/api/admin/permissions', headers: ADMIN_HEADERS });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.permissions).toEqual([]);
        });

        it('éxito con role_permissions=null (sin error): todos los roles quedan con arreglo vacío', async () => {
            mockFrom('role_permissions', { select: () => Promise.resolve({ data: null, error: null }) });
            const res = await app.inject({ method: 'GET', url: '/api/admin/permissions', headers: ADMIN_HEADERS });
            expect(res.statusCode).toBe(200);
            const { roleDefaults } = res.json().data;
            expect(roleDefaults).toEqual({ owner: [], admin: [], member: [], viewer: [] });
        });
    });

    describe('GET /api/admin/organizations/:id/permissions', () => {
        it('si falla la consulta a permissions, responde 500 con el mensaje real del error', async () => {
            mockFrom('permissions', { select: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'Simulated permissions error' } }) }) });
            const res = await app.inject({ method: 'GET', url: `/api/admin/organizations/${orgId}/permissions`, headers: ADMIN_HEADERS });
            expect(res.statusCode).toBe(500);
            expect(res.json()).toEqual({ success: false, error: 'Simulated permissions error' });
        });

        it('si falla la consulta a role_permissions, responde 500 con el mensaje real del error', async () => {
            mockFrom('role_permissions', { select: () => Promise.resolve({ data: null, error: { message: 'Simulated role_permissions error' } }) });
            const res = await app.inject({ method: 'GET', url: `/api/admin/organizations/${orgId}/permissions`, headers: ADMIN_HEADERS });
            expect(res.statusCode).toBe(500);
            expect(res.json()).toEqual({ success: false, error: 'Simulated role_permissions error' });
        });

        it('si falla la consulta a organization_role_permissions, responde 500 con el mensaje real del error', async () => {
            mockFrom('organization_role_permissions', { select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'Simulated overrides error' } }) }) });
            const res = await app.inject({ method: 'GET', url: `/api/admin/organizations/${orgId}/permissions`, headers: ADMIN_HEADERS });
            expect(res.statusCode).toBe(500);
            expect(res.json()).toEqual({ success: false, error: 'Simulated overrides error' });
        });

        it('éxito con permissions=null: el mapa por rol queda vacío (sin filas) en vez de fallar', async () => {
            mockFrom('permissions', { select: () => ({ order: () => Promise.resolve({ data: null, error: null }) }) });
            const res = await app.inject({ method: 'GET', url: `/api/admin/organizations/${orgId}/permissions`, headers: ADMIN_HEADERS });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.roles.viewer).toEqual([]);
        });

        it('éxito con role_permissions=null: defaultEnabled es false para todos', async () => {
            mockFrom('role_permissions', { select: () => Promise.resolve({ data: null, error: null }) });
            const res = await app.inject({ method: 'GET', url: `/api/admin/organizations/${orgId}/permissions`, headers: ADMIN_HEADERS });
            expect(res.statusCode).toBe(200);
            const viewerRow = res.json().data.roles.viewer.find((r: any) => r.permissionKey === PERMISSION_KEYS.VIEW_CONTACTS);
            expect(viewerRow.defaultEnabled).toBe(false);
        });

        it('éxito con organization_role_permissions=null: no hay overrides, todo queda en origen "default"', async () => {
            mockFrom('organization_role_permissions', { select: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) });
            const res = await app.inject({ method: 'GET', url: `/api/admin/organizations/${orgId}/permissions`, headers: ADMIN_HEADERS });
            expect(res.statusCode).toBe(200);
            const viewerRow = res.json().data.roles.viewer.find((r: any) => r.permissionKey === PERMISSION_KEYS.VIEW_CONTACTS);
            expect(viewerRow.origin).toBe('default');
            expect(viewerRow.override).toBeNull();
        });
    });

    describe('PATCH /api/admin/organizations/:id/permissions — validación de campos', () => {
        it('sin "role" → 400 con el mensaje exacto', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/organizations/${orgId}/permissions`,
                headers: ADMIN_HEADERS,
                payload: { permission_key: PERMISSION_KEYS.VIEW_CONTACTS, enabled: true, reason: 'x' },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json()).toEqual({ success: false, error: 'El campo "role" debe ser uno de: owner, admin, member, viewer.' });
        });

        it('"role" inválido (no es owner/admin/member/viewer) → 400', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/organizations/${orgId}/permissions`,
                headers: ADMIN_HEADERS,
                payload: { role: 'super-admin-inventado', permission_key: PERMISSION_KEYS.VIEW_CONTACTS, enabled: true, reason: 'x' },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().error).toContain('owner, admin, member, viewer');
        });

        it('sin "permission_key" → 400 con el mensaje exacto', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/organizations/${orgId}/permissions`,
                headers: ADMIN_HEADERS,
                payload: { role: 'viewer', enabled: true, reason: 'x' },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json()).toEqual({ success: false, error: 'El campo "permission_key" es obligatorio.' });
        });

        it('sin "enabled" (boolean) → 400 con el mensaje exacto', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/organizations/${orgId}/permissions`,
                headers: ADMIN_HEADERS,
                payload: { role: 'viewer', permission_key: PERMISSION_KEYS.VIEW_CONTACTS, reason: 'x' },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json()).toEqual({ success: false, error: 'El campo "enabled" (boolean) es obligatorio.' });
        });

        it('sin "reason" → 400 con el mensaje exacto', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/organizations/${orgId}/permissions`,
                headers: ADMIN_HEADERS,
                payload: { role: 'viewer', permission_key: PERMISSION_KEYS.VIEW_CONTACTS, enabled: true },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json()).toEqual({ success: false, error: 'El campo "reason" es obligatorio.' });
        });

        it('"reason" en blanco (solo espacios) → 400', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/organizations/${orgId}/permissions`,
                headers: ADMIN_HEADERS,
                payload: { role: 'viewer', permission_key: PERMISSION_KEYS.VIEW_CONTACTS, enabled: true, reason: '   ' },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().error).toBe('El campo "reason" es obligatorio.');
        });

        it('un permiso is_sensitive sin "confirm: true" se rechaza con el código y mensaje exactos', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/organizations/${orgId}/permissions`,
                headers: ADMIN_HEADERS,
                payload: { role: 'viewer', permission_key: PERMISSION_KEYS.VIEW_COSTS, enabled: true, reason: 'Prueba' },
            });
            expect(res.statusCode).toBe(400);
            const body = res.json();
            expect(body.code).toBe('CONFIRMATION_REQUIRED');
            expect(body.message).toBe(
                `"${PERMISSION_KEYS.VIEW_COSTS}" es un permiso sensible. Se requiere confirmación explícita: envíe "confirm": true en el cuerpo de la petición.`
            );
        });

        it('contraparte de éxito: un permiso NO sensible se concede sin necesitar "confirm"', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/organizations/${orgId}/permissions`,
                headers: ADMIN_HEADERS,
                payload: { role: 'viewer', permission_key: PERMISSION_KEYS.EDIT_CONTACTS, enabled: true, reason: 'Prueba no sensible' },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ success: true });

            const mapRes = await app.inject({
                method: 'GET',
                url: `/api/admin/organizations/${orgId}/permissions`,
                headers: ADMIN_HEADERS,
            });
            const row = mapRes.json().data.roles.viewer.find((r: any) => r.permissionKey === PERMISSION_KEYS.EDIT_CONTACTS);
            expect(row.effective).toBe(true);
            expect(row.origin).toBe('override_grant');
        });

        it('si el RPC falla a nivel de red/DB (no un {success:false} de negocio), responde 500 y no invalida el caché', async () => {
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({ data: null, error: { message: 'Simulated network error' } } as any);
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/organizations/${orgId}/permissions`,
                headers: ADMIN_HEADERS,
                payload: { role: 'viewer', permission_key: PERMISSION_KEYS.VIEW_CONTACTS, enabled: true, reason: 'x' },
            });
            expect(res.statusCode).toBe(500);
            expect(res.json()).toEqual({ success: false, error: 'No se pudo aplicar el override.' });
        });

        it('rechazo de negocio del RPC (ej. OWNER_INVARIANT) responde 400 con error_code y message tal cual', async () => {
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({
                data: { success: false, error_code: 'OWNER_INVARIANT', message: 'El owner nunca pierde este permiso.' },
                error: null,
            } as any);
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/organizations/${orgId}/permissions`,
                headers: ADMIN_HEADERS,
                payload: { role: 'owner', permission_key: PERMISSION_KEYS.MANAGE_USERS, enabled: false, reason: 'x', confirm: true },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json()).toEqual({ success: false, error: 'El owner nunca pierde este permiso.', code: 'OWNER_INVARIANT' });
        });
    });

    describe('GET /api/admin/organizations/:id/permissions/audit', () => {
        it('si falla la consulta, responde 500 con el mensaje real del error', async () => {
            mockFrom('permission_audit_log', { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'Simulated audit error' } }) }) }) });
            const res = await app.inject({
                method: 'GET',
                url: `/api/admin/organizations/${orgId}/permissions/audit`,
                headers: ADMIN_HEADERS,
            });
            expect(res.statusCode).toBe(500);
            expect(res.json()).toEqual({ success: false, error: 'Simulated audit error' });
        });

        it('éxito con data=null (sin error) devuelve arreglo vacío, no null', async () => {
            mockFrom('permission_audit_log', { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: null }) }) }) });
            const res = await app.inject({
                method: 'GET',
                url: `/api/admin/organizations/${orgId}/permissions/audit`,
                headers: ADMIN_HEADERS,
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ success: true, data: [] });
        });
    });
});
