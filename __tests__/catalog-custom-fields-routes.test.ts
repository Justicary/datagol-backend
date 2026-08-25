import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import catalogRoutes from '../src/routes/catalogs.js';
import { ORGANIZATION_ROLES } from '../src/types/organization-roles.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
    await app.register(supabasePlugin);
    await app.register(catalogRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-cf-routes-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
    });
    if (createErr || !created.user) throw new Error(`No se pudo crear el usuario de prueba: ${createErr?.message}`);
    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) throw new Error(`No se pudo iniciar sesión de prueba: ${signInErr?.message}`);
    return { userId: created.user.id, jwt: session.session.access_token };
}

async function deleteTestUser(userId: string): Promise<void> {
    await supabaseAdmin.auth.admin.deleteUser(userId);
}

describe('Rutas de Campos Personalizados de Catálogo (catalog_custom_fields)', () => {
    let app: FastifyInstance;
    let ownerUser: TestUser;
    let otherUser: TestUser;
    let orgId: string;
    let catalogId: string;

    beforeAll(async () => {
        app = await buildTestApp();
        ownerUser = await createTestUserWithJwt();
        otherUser = await createTestUserWithJwt();

        // 1. Crear organización con owner
        const { data: org, error: orgErr } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Org Test Custom Fields',
            p_email: `test-cf-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: ownerUser.userId,
        });
        if (orgErr || !org) throw new Error(`Error creando organización: ${orgErr?.message}`);
        orgId = org.id;

        await supabaseAdmin.from('organizations').update({ plan_key: 'elite' }).eq('id', orgId);

        // 2. Crear catálogo
        const { data: cat, error: catErr } = await supabaseAdmin
            .from('catalogs')
            .insert({
                owner_organization_id: orgId,
                name: 'Catálogo con Campos Personalizados',
            })
            .select('id')
            .single();
        if (catErr || !cat) throw new Error(`Error creando catálogo: ${catErr?.message}`);
        catalogId = cat.id;

        // 3. Crear catalog_access
        await supabaseAdmin.from('catalog_access').insert({
            catalog_id: catalogId,
            organization_id: orgId,
            can_edit: true,
        });
    });

    afterAll(async () => {
        await supabaseAdmin.from('catalogs').delete().eq('id', catalogId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await deleteTestUser(ownerUser.userId);
        await deleteTestUser(otherUser.userId);
        await app.close();
    });

    it('GET /api/organizations/:id/catalogs/:catalogId/custom-fields devuelve array vacío inicialmente', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/catalogs/${catalogId}/custom-fields`,
            headers: { authorization: `Bearer ${ownerUser.jwt}` },
        });

        expect(res.statusCode).toBe(200);
        const json = res.json();
        expect(json.success).toBe(true);
        expect(Array.isArray(json.data)).toBe(true);
        expect(json.data).toHaveLength(0);
    });

    it('POST /api/organizations/:id/catalogs/:catalogId/custom-fields crea un campo de producto exitosamente', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/catalogs/${catalogId}/custom-fields`,
            headers: { authorization: `Bearer ${ownerUser.jwt}` },
            payload: {
                entityType: 'product',
                name: 'Puntos de Lealtad',
                fieldType: 'number',
                description: 'Puntos acumulables en la compra',
                isRequired: false,
                includeInRag: true,
                orderIndex: 1,
            },
        });

        expect(res.statusCode).toBe(201);
        const json = res.json();
        expect(json.success).toBe(true);
        expect(json.data.key).toBe('puntos_de_lealtad');
        expect(json.data.name).toBe('Puntos de Lealtad');
        expect(json.data.fieldType).toBe('number');
        expect(json.data.entityType).toBe('product');
        expect(json.data.includeInRag).toBe(true);
    });

    it('POST crea un campo de tipo select para variante validando opciones', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/catalogs/${catalogId}/custom-fields`,
            headers: { authorization: `Bearer ${ownerUser.jwt}` },
            payload: {
                entityType: 'variant',
                name: 'Talla',
                fieldType: 'select',
                options: ['CH', 'M', 'G', 'XG'],
                isRequired: true,
                includeInRag: false,
            },
        });

        expect(res.statusCode).toBe(201);
        const json = res.json();
        expect(json.success).toBe(true);
        expect(json.data.key).toBe('talla');
        expect(json.data.options).toEqual(['CH', 'M', 'G', 'XG']);
        expect(json.data.isRequired).toBe(true);
        expect(json.data.includeInRag).toBe(false);
    });

    it('POST rechaza select sin opciones', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/catalogs/${catalogId}/custom-fields`,
            headers: { authorization: `Bearer ${ownerUser.jwt}` },
            payload: {
                entityType: 'product',
                name: 'Color',
                fieldType: 'select',
                options: [],
            },
        });

        expect(res.statusCode).toBe(400);
        const json = res.json();
        expect(json.success).toBe(false);
    });

    it('POST rechaza key duplicado para la misma entidad en el catálogo', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/catalogs/${catalogId}/custom-fields`,
            headers: { authorization: `Bearer ${ownerUser.jwt}` },
            payload: {
                entityType: 'product',
                name: 'Puntos de Lealtad',
                fieldType: 'number',
            },
        });

        expect(res.statusCode).toBe(409);
        const json = res.json();
        expect(json.success).toBe(false);
        expect(json.error).toContain('Ya existe un campo con la clave');
    });

    it('PATCH actualiza las propiedades de un campo personalizado', async () => {
        // Obtenemos el campo creado antes
        const listRes = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/catalogs/${catalogId}/custom-fields`,
            headers: { authorization: `Bearer ${ownerUser.jwt}` },
        });
        const fields = listRes.json().data;
        const puntosField = fields.find((f: any) => f.key === 'puntos_de_lealtad');
        expect(puntosField).toBeDefined();

        const patchRes = await app.inject({
            method: 'PATCH',
            url: `/api/organizations/${orgId}/catalogs/${catalogId}/custom-fields/${puntosField.id}`,
            headers: { authorization: `Bearer ${ownerUser.jwt}` },
            payload: {
                name: 'Puntos Rewards',
                description: 'Puntos oficiales del club rewards',
                isRequired: true,
                orderIndex: 5,
            },
        });

        expect(patchRes.statusCode).toBe(200);
        const json = patchRes.json();
        expect(json.success).toBe(true);
        expect(json.data.name).toBe('Puntos Rewards');
        expect(json.data.description).toBe('Puntos oficiales del club rewards');
        expect(json.data.isRequired).toBe(true);
        expect(json.data.orderIndex).toBe(5);
    });

    it('DELETE elimina un campo personalizado', async () => {
        const listRes = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/catalogs/${catalogId}/custom-fields`,
            headers: { authorization: `Bearer ${ownerUser.jwt}` },
        });
        const fields = listRes.json().data;
        const tallaField = fields.find((f: any) => f.key === 'talla');
        expect(tallaField).toBeDefined();

        const delRes = await app.inject({
            method: 'DELETE',
            url: `/api/organizations/${orgId}/catalogs/${catalogId}/custom-fields/${tallaField.id}`,
            headers: { authorization: `Bearer ${ownerUser.jwt}` },
        });

        expect(delRes.statusCode).toBe(200);
        expect(delRes.json().success).toBe(true);

        // Verificamos que ya no aparezca
        const listRes2 = await app.inject({
            method: 'GET',
            url: `/api/organizations/${orgId}/catalogs/${catalogId}/custom-fields`,
            headers: { authorization: `Bearer ${ownerUser.jwt}` },
        });
        const fields2 = listRes2.json().data;
        expect(fields2.find((f: any) => f.key === 'talla')).toBeUndefined();
    });

    it('DELETE con ID inexistente devuelve 404', async () => {
        const nonExistentId = crypto.randomUUID();
        const delRes = await app.inject({
            method: 'DELETE',
            url: `/api/organizations/${orgId}/catalogs/${catalogId}/custom-fields/${nonExistentId}`,
            headers: { authorization: `Bearer ${ownerUser.jwt}` },
        });

        expect(delRes.statusCode).toBe(404);
        expect(delRes.json().success).toBe(false);
    });
});
