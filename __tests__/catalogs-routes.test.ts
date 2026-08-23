import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import catalogRoutes from '../src/routes/catalogs.js';
import { ORGANIZATION_ROLES } from '../src/types/organization-roles.js';
import * as productImageService from '../src/services/product-image-service.js';

// La columna imageUrl de importación resuelve DNS de verdad para bloquear
// SSRF (catalog-import-service.ts) — se mockea a una IP pública fija para
// que las pruebas no dependan de resolución de red real ni de que
// "example.invalid" (deliberadamente no resoluble, RFC 2606) falle antes de
// tiempo.
vi.mock('dns/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('dns/promises')>();
    return { ...actual, lookup: vi.fn().mockResolvedValue({ address: '203.0.113.10', family: 4 }) };
});

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
    const email = `test-catalogs-routes-${crypto.randomUUID()}@example.invalid`;
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

function buildImportMultipart(opts: { mode: string; columnMapping: Record<string, string>; csv: string; filename?: string }): {
    payload: Buffer;
    contentType: string;
} {
    const boundary = `----TestBoundary${crypto.randomUUID()}`;
    const parts: Buffer[] = [
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\n${opts.mode}\r\n`),
        Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="columnMapping"\r\n\r\n${JSON.stringify(opts.columnMapping)}\r\n`
        ),
        Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${opts.filename ?? 'catalogo.csv'}"\r\nContent-Type: text/csv\r\n\r\n`
        ),
        Buffer.from(opts.csv),
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function buildFileOnlyMultipart(opts: { csv: string; filename?: string }): { payload: Buffer; contentType: string } {
    const boundary = `----TestBoundary${crypto.randomUUID()}`;
    const parts: Buffer[] = [
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${opts.filename ?? 'catalogo.csv'}"\r\nContent-Type: text/csv\r\n\r\n`),
        Buffer.from(opts.csv),
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('routes/catalogs.ts — FASE E', () => {
    let owner: TestUser;
    let member: TestUser;
    let outsiderOwner: TestUser;
    let orgId: string;
    let outsiderOrgId: string;
    let catalogId: string;

    beforeAll(async () => {
        owner = await createTestUserWithJwt();
        member = await createTestUserWithJwt();
        outsiderOwner = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Catalogs Routes Test Org',
            p_email: `catalogs-routes-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`Setup falló creando organización: ${error?.message}`);
        orgId = org.id;
        await supabaseAdmin.from('organizations').update({ plan_key: 'elite' }).eq('id', orgId);

        const { error: memberErr } = await supabaseAdmin
            .from('organization_members')
            .insert({ organization_id: orgId, user_id: member.userId, role: ORGANIZATION_ROLES.MEMBER });
        if (memberErr) throw new Error(`Setup falló agregando member: ${memberErr.message}`);

        // Organización de OTRO grupo (no comparte credential_group_id con orgId) — para probar el rechazo de "compartir fuera del grupo".
        const { data: outsiderOrg, error: outsiderErr } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Catalogs Routes Outsider Org',
            p_email: `catalogs-routes-outsider-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: outsiderOwner.userId,
        });
        if (outsiderErr || !outsiderOrg) throw new Error(`Setup falló creando organización externa: ${outsiderErr?.message}`);
        outsiderOrgId = outsiderOrg.id;
        await supabaseAdmin.from('organizations').update({ plan_key: 'elite' }).eq('id', outsiderOrgId);

        const { data: catalog, error: catErr } = await supabaseAdmin
            .from('catalogs')
            .insert({ owner_organization_id: orgId, name: 'Catálogo de prueba (catalogs-routes)' })
            .select('id')
            .single();
        if (catErr || !catalog) throw new Error(`Setup falló creando catálogo: ${catErr?.message}`);
        catalogId = catalog.id;
    });

    afterAll(async () => {
        await supabaseAdmin.from('catalog_imports').delete().eq('catalog_id', catalogId);
        await supabaseAdmin.from('catalogs').delete().eq('id', catalogId);
        await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', outsiderOrgId);
        await deleteTestUser(owner.userId);
        await deleteTestUser(member.userId);
        await deleteTestUser(outsiderOwner.userId);
    });

    describe('POST /api/organizations/:id/catalogs', () => {
        it('un member SIN manage_catalog recibe 403', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs`,
                    headers: { authorization: `Bearer ${member.jwt}` },
                    payload: { name: 'Catálogo desde member' },
                });
                expect(response.statusCode).toBe(403);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: el owner (manage_catalog) crea un catálogo', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { name: 'Catálogo creado por owner' },
                });
                expect(response.statusCode).toBe(201);
                const body = response.json();
                expect(body.data.name).toBe('Catálogo creado por owner');
                await supabaseAdmin.from('catalogs').delete().eq('id', body.data.id);
            } finally {
                await app.close();
            }
        });
    });

    describe('POST /api/organizations/:id/catalogs/:catalogId/import/inspect', () => {
        it('un member SIN manage_catalog recibe 403', async () => {
            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildFileOnlyMultipart({ csv: 'SKU,Nombre\nX-1,Producto X\n' });
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import/inspect`,
                    headers: { authorization: `Bearer ${member.jwt}`, 'content-type': contentType },
                    payload,
                });
                expect(response.statusCode).toBe(403);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: el owner ve encabezados y filas de ejemplo SIN mandar mode ni columnMapping', async () => {
            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildFileOnlyMultipart({
                    csv: 'SKU,Nombre,Precio\nINS-1,Producto uno,100\nINS-2,Producto dos,200\n',
                });
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import/inspect`,
                    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': contentType },
                    payload,
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.data.headers).toEqual(['SKU', 'Nombre', 'Precio']);
                expect(body.data.totalRows).toBe(2);
                expect(body.data.sampleRows[0]).toMatchObject({ SKU: 'INS-1', Nombre: 'Producto uno', Precio: '100' });
            } finally {
                await app.close();
            }
        });

        it('contraparte de rechazo: sin archivo en la petición devuelve 400, no 500', async () => {
            const app = await buildTestApp();
            try {
                const boundary = `----TestBoundary${crypto.randomUUID()}`;
                const payload = Buffer.from(`--${boundary}--\r\n`);
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import/inspect`,
                    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
                    payload,
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('sampleRows se acota a las primeras filas aunque el archivo traiga más', async () => {
            const rows = Array.from({ length: 20 }, (_, i) => `INS-MANY-${i},Producto ${i}`).join('\n');
            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildFileOnlyMultipart({ csv: `SKU,Nombre\n${rows}\n` });
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import/inspect`,
                    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': contentType },
                    payload,
                });
                const body = response.json();
                expect(body.data.totalRows).toBe(20);
                expect(body.data.sampleRows.length).toBeLessThan(20);
            } finally {
                await app.close();
            }
        });
    });

    describe('POST /api/organizations/:id/catalogs/:catalogId/import/preview', () => {
        it('un member SIN manage_catalog recibe 403 (checklist: "un member recibe 403 al importar")', async () => {
            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildImportMultipart({
                    mode: 'completo',
                    columnMapping: { sku: 'SKU', name: 'Nombre' },
                    csv: 'SKU,Nombre\nX-1,Producto X\n',
                });
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import/preview`,
                    headers: { authorization: `Bearer ${member.jwt}`, 'content-type': contentType },
                    payload,
                });
                expect(response.statusCode).toBe(403);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: el owner ve la vista previa con altas/cambios/errores contados', async () => {
            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildImportMultipart({
                    mode: 'completo',
                    columnMapping: { sku: 'SKU', name: 'Nombre' },
                    csv: 'SKU,Nombre\nPREV-1,Producto Preview 1\nPREV-2,Producto Preview 2\n',
                });
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import/preview`,
                    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': contentType },
                    payload,
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.data.totalRows).toBe(2);
                expect(body.data.toCreate).toBe(2);
                expect(body.data.errors).toEqual([]);
            } finally {
                await app.close();
            }
        });

        it('SKU duplicado dentro del archivo se detecta en la vista previa', async () => {
            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildImportMultipart({
                    mode: 'completo',
                    columnMapping: { sku: 'SKU', name: 'Nombre' },
                    csv: 'SKU,Nombre\nDUP-PREV,Primero\ndup-prev,Segundo (mismo SKU)\n',
                });
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import/preview`,
                    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': contentType },
                    payload,
                });
                const body = response.json();
                expect(body.data.duplicateSkusInFile).toEqual(['DUP-PREV']);
                expect(body.data.errors.length).toBeGreaterThan(0);
            } finally {
                await app.close();
            }
        });

        it('modo solo_precios contra un catálogo sin ese SKU reporta error, nunca crea nada (no se le pide capa descriptiva)', async () => {
            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildImportMultipart({
                    mode: 'solo_precios',
                    columnMapping: { sku: 'SKU', price: 'Precio' },
                    csv: 'SKU,Precio\nNO-EXISTE-EN-CATALOGO,100\n',
                });
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import/preview`,
                    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': contentType },
                    payload,
                });
                const body = response.json();
                expect(body.data.toCreate).toBe(0);
                expect(body.data.toUpdate).toBe(0);
                expect(body.data.errors.length).toBe(1);
            } finally {
                await app.close();
            }
        });
    });

    describe('POST /api/organizations/:id/catalogs/:catalogId/import (aplicar)', () => {
        it('un member SIN manage_catalog recibe 403 (checklist: "un member recibe 403 al importar")', async () => {
            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildImportMultipart({
                    mode: 'completo',
                    columnMapping: { sku: 'SKU', name: 'Nombre' },
                    csv: 'SKU,Nombre\nAPPLY-MEMBER-1,Producto\n',
                });
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import`,
                    headers: { authorization: `Bearer ${member.jwt}`, 'content-type': contentType },
                    payload,
                });
                expect(response.statusCode).toBe(403);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: el owner aplica una importación completa, crea producto+variante y registra catalog_imports', async () => {
            const app = await buildTestApp();
            const sku = `APPLY-OK-${Date.now()}`;
            try {
                const { payload, contentType } = buildImportMultipart({
                    mode: 'completo',
                    columnMapping: { sku: 'SKU', name: 'Nombre', price: 'Precio' },
                    csv: `SKU,Nombre,Precio\n${sku},Producto aplicado,250\n`,
                });
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import`,
                    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': contentType },
                    payload,
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.data.rowsCreated).toBe(1);
                expect(body.data.status).toBe('completado');

                const { data: variant } = await supabaseAdmin
                    .from('product_variants')
                    .select('id, price, product_id')
                    .eq('catalog_id', catalogId)
                    .eq('sku', sku)
                    .maybeSingle();
                expect(variant?.price).toBe(250);

                const { data: importRows } = await supabaseAdmin.from('catalog_imports').select('id').eq('id', body.data.importId);
                expect(importRows?.length).toBe(1);
            } finally {
                await supabaseAdmin.from('product_variants').delete().eq('catalog_id', catalogId).eq('sku', sku);
                await app.close();
            }
        });

        it('columna imageUrl mapeada: descarga y adjunta la imagen del producto sin afectar el conteo de altas', async () => {
            vi.spyOn(productImageService, 'uploadProductImage').mockResolvedValue({
                imagePath: 'irrelevante.png',
                mimeType: 'image/png',
                sizeBytes: 10,
                uploadedAt: new Date().toISOString(),
            });
            // Solo se intercepta la URL de la imagen — el resto (Supabase Auth,
            // PostgREST) también usa fetch global y debe seguir funcionando de
            // verdad, o la petición ni siquiera pasa la autenticación.
            const realFetch = global.fetch;
            vi.stubGlobal(
                'fetch',
                vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
                    if (url.includes('cdn.example.com')) {
                        return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response;
                    }
                    return realFetch(input, init);
                })
            );
            const sku = `APPLY-IMG-OK-${Date.now()}`;
            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildImportMultipart({
                    mode: 'completo',
                    columnMapping: { sku: 'SKU', name: 'Nombre', imageUrl: 'Imagen' },
                    csv: `SKU,Nombre,Imagen\n${sku},Producto con imagen importada,https://cdn.example.com/foto.png\n`,
                });
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import`,
                    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': contentType },
                    payload,
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.data.rowsCreated).toBe(1);
                expect(body.data.imageErrors).toEqual([]);
                expect(productImageService.uploadProductImage).toHaveBeenCalledTimes(1);
            } finally {
                await supabaseAdmin.from('product_variants').delete().eq('catalog_id', catalogId).eq('sku', sku);
                vi.unstubAllGlobals();
                vi.restoreAllMocks();
                await app.close();
            }
        });

        it('contraparte de rechazo: una URL de imagen que resuelve a red interna (SSRF) se reporta en imageErrors SIN invalidar la fila', async () => {
            const sku = `APPLY-IMG-SSRF-${Date.now()}`;
            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildImportMultipart({
                    mode: 'completo',
                    columnMapping: { sku: 'SKU', name: 'Nombre', imageUrl: 'Imagen' },
                    csv: `SKU,Nombre,Imagen\n${sku},Producto con imagen rota,http://localhost/foto.png\n`,
                });
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import`,
                    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': contentType },
                    payload,
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                // La fila se creó igual — el fallo de imagen no la invalida.
                expect(body.data.rowsCreated).toBe(1);
                expect(body.data.errors).toEqual([]);
                expect(body.data.imageErrors).toHaveLength(1);
                expect(body.data.imageErrors[0].message).toContain(sku);

                const { data: variant } = await supabaseAdmin.from('product_variants').select('id').eq('catalog_id', catalogId).eq('sku', sku).maybeSingle();
                expect(variant).not.toBeNull();
            } finally {
                await supabaseAdmin.from('product_variants').delete().eq('catalog_id', catalogId).eq('sku', sku);
                await app.close();
            }
        });

        it('modo solo_precios actualiza SOLO el precio de una variante existente y NO marca el producto para resincronizar con la KB', async () => {
            const sku = `APPLY-SOLO-PRECIOS-${Date.now()}`;
            const { data: product } = await supabaseAdmin.from('products').insert({ catalog_id: catalogId, name: 'Producto solo_precios' }).select('id').single();
            const { data: variant } = await supabaseAdmin
                .from('product_variants')
                .insert({ product_id: product!.id, catalog_id: catalogId, sku, price: 10 })
                .select('id')
                .single();

            // Confirmar sincronizado de antemano, para distinguir "se re-marcó pendiente" de "ya estaba pendiente" tras el alta.
            const { data: org } = await supabaseAdmin.from('organizations').select('credential_group_id').eq('id', orgId).single();
            await supabaseAdmin
                .from('product_kb_sync')
                .update({ status: 'sincronizado' })
                .eq('product_id', product!.id)
                .eq('credential_group_id', org!.credential_group_id);

            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildImportMultipart({
                    mode: 'solo_precios',
                    columnMapping: { sku: 'SKU', price: 'Precio' },
                    csv: `SKU,Precio\n${sku},777\n`,
                });
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import`,
                    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': contentType },
                    payload,
                });
                expect(response.statusCode).toBe(200);
                expect(response.json().data.rowsUpdated).toBe(1);

                const { data: updatedVariant } = await supabaseAdmin.from('product_variants').select('price').eq('id', variant!.id).single();
                expect(updatedVariant?.price).toBe(777);

                const { data: syncRow } = await supabaseAdmin
                    .from('product_kb_sync')
                    .select('status')
                    .eq('product_id', product!.id)
                    .eq('credential_group_id', org!.credential_group_id)
                    .maybeSingle();
                expect(syncRow?.status).toBe('sincronizado');
            } finally {
                await supabaseAdmin.from('product_variants').delete().eq('id', variant!.id);
                await supabaseAdmin.from('products').delete().eq('id', product!.id);
                await app.close();
            }
        });
    });

    describe('GET /api/organizations/:id/catalogs/:catalogId/imports', () => {
        it('un member CON view_catalog (default del rol) puede listar, aunque no pueda importar', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/imports`,
                    headers: { authorization: `Bearer ${member.jwt}` },
                });
                expect(response.statusCode).toBe(200);
                expect(Array.isArray(response.json().data)).toBe(true);
            } finally {
                await app.close();
            }
        });
    });

    describe('POST /api/organizations/:id/catalogs/:catalogId/share', () => {
        it('compartir con una organización de OTRO grupo se rechaza con mensaje claro (nunca un 500 crudo del trigger)', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/share`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { organizationId: outsiderOrgId },
                });
                expect(response.statusCode).toBe(400);
                expect(response.json().error).toContain('mismo grupo de credenciales');
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: compartir dentro del MISMO grupo funciona', async () => {
            // Une temporalmente outsiderOrg al grupo de orgId para probar el camino de éxito.
            const { data: orgRow } = await supabaseAdmin.from('organizations').select('credential_group_id').eq('id', orgId).single();
            await supabaseAdmin.from('organizations').update({ credential_group_id: orgRow!.credential_group_id }).eq('id', outsiderOrgId);

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/share`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { organizationId: outsiderOrgId, canEdit: false },
                });
                expect(response.statusCode).toBe(200);

                const { data: access } = await supabaseAdmin
                    .from('catalog_access')
                    .select('can_edit')
                    .eq('catalog_id', catalogId)
                    .eq('organization_id', outsiderOrgId)
                    .maybeSingle();
                expect(access).toMatchObject({ can_edit: false });
            } finally {
                await supabaseAdmin.from('catalog_access').delete().eq('catalog_id', catalogId).eq('organization_id', outsiderOrgId);
                await app.close();
            }
        });
    });

    describe('GET /api/organizations/:id/credential-group/organizations', () => {
        let siblingOrgId: string;
        let foreignOrgId: string;
        let foreignGroupId: string;

        beforeAll(async () => {
            const { data: orgRow } = await supabaseAdmin.from('organizations').select('credential_group_id').eq('id', orgId).single();

            const { data: sibling } = await supabaseAdmin
                .from('organizations')
                .insert({ name: 'Hermana del grupo (credential-group test)', email: `sibling-cred-group-${crypto.randomUUID()}@example.invalid`, credential_group_id: orgRow!.credential_group_id })
                .select('id')
                .single();
            siblingOrgId = sibling!.id;

            const { data: fg } = await supabaseAdmin.from('credential_groups').insert({ name: 'Grupo ajeno (credential-group test)' }).select('id').single();
            foreignGroupId = fg!.id;
            const { data: foreign } = await supabaseAdmin
                .from('organizations')
                .insert({ name: 'Organización de otro grupo (credential-group test)', email: `foreign-cred-group-${crypto.randomUUID()}@example.invalid`, credential_group_id: foreignGroupId })
                .select('id')
                .single();
            foreignOrgId = foreign!.id;
            await supabaseAdmin.from('credential_groups').update({ owner_organization_id: foreignOrgId }).eq('id', foreignGroupId);
        });

        afterAll(async () => {
            await supabaseAdmin.from('organizations').delete().in('id', [siblingOrgId, foreignOrgId]);
            await supabaseAdmin.from('credential_groups').delete().eq('id', foreignGroupId);
        });

        it('un member SIN manage_catalog recibe 403', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgId}/credential-group/organizations`,
                    headers: { authorization: `Bearer ${member.jwt}` },
                });
                expect(response.statusCode).toBe(403);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: el owner ve a la hermana del grupo, nunca a sí mismo ni a organizaciones de otro grupo', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgId}/credential-group/organizations`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(response.statusCode).toBe(200);
                const ids = response.json().data.map((o: { id: string }) => o.id);
                expect(ids).toContain(siblingOrgId);
                expect(ids).not.toContain(orgId);
                expect(ids).not.toContain(foreignOrgId);
            } finally {
                await app.close();
            }
        });
    });

    describe('Aislamiento: catálogo de otra organización', () => {
        it('una organización sin catalog_access recibe 404, no el contenido del catálogo', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${outsiderOrgId}/catalogs/${catalogId}/imports`,
                    headers: { authorization: `Bearer ${outsiderOwner.jwt}` },
                });
                expect(response.statusCode).toBe(404);
            } finally {
                await app.close();
            }
        });
    });

    describe('Imagen de producto (POST/GET/DELETE .../products/:productId/image)', () => {
        let imageProductId: string;

        beforeAll(async () => {
            const { data: product, error } = await supabaseAdmin
                .from('products')
                .insert({ catalog_id: catalogId, name: 'Producto con imagen (catalogs-routes)' })
                .select('id')
                .single();
            if (error || !product) throw new Error(`Setup falló creando producto: ${error?.message}`);
            imageProductId = product.id;
        });

        afterAll(async () => {
            await supabaseAdmin.from('products').delete().eq('id', imageProductId);
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        function buildSingleFileMultipart(filename: string, contentType: string, content: Buffer): { payload: Buffer; contentType: string } {
            const boundary = `----TestBoundary${crypto.randomUUID()}`;
            const payload = Buffer.concat([
                Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
                content,
                Buffer.from(`\r\n--${boundary}--\r\n`),
            ]);
            return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
        }

        it('un member SIN manage_catalog recibe 403 al subir una imagen', async () => {
            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildSingleFileMultipart('foto.png', 'image/png', Buffer.from('fake-png-bytes'));
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/products/${imageProductId}/image`,
                    headers: { authorization: `Bearer ${member.jwt}`, 'content-type': contentType },
                    payload,
                });
                expect(response.statusCode).toBe(403);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: el owner sube una imagen y recibe una URL firmada', async () => {
            vi.spyOn(productImageService, 'uploadProductImage').mockResolvedValue({
                imagePath: `${catalogId}/${imageProductId}/foto.png`,
                mimeType: 'image/png',
                sizeBytes: 14,
                uploadedAt: new Date().toISOString(),
            });
            vi.spyOn(productImageService, 'getProductImageSignedUrl').mockResolvedValue('https://storage.supabase.co/signed/foto.png');

            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildSingleFileMultipart('foto.png', 'image/png', Buffer.from('fake-png-bytes'));
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/products/${imageProductId}/image`,
                    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': contentType },
                    payload,
                });
                expect(response.statusCode).toBe(201);
                const body = response.json();
                expect(body.data.imageUrl).toBe('https://storage.supabase.co/signed/foto.png');
                expect(body.data.mimeType).toBe('image/png');
            } finally {
                await app.close();
            }
        });

        it('contraparte de rechazo: un archivo inválido devuelve 400 con el mensaje del servicio, no un 500', async () => {
            vi.spyOn(productImageService, 'uploadProductImage').mockRejectedValue(new Error('La imagen no es válida. Solo se admiten PNG y JPEG de hasta 512 KB.'));

            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildSingleFileMultipart('doc.pdf', 'application/pdf', Buffer.from('%PDF-1.7'));
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/products/${imageProductId}/image`,
                    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': contentType },
                    payload,
                });
                expect(response.statusCode).toBe(400);
                expect(response.json().error).toContain('512 KB');
            } finally {
                await app.close();
            }
        });

        it('un productId que no pertenece al catálogo recibe 404', async () => {
            const app = await buildTestApp();
            try {
                const { payload, contentType } = buildSingleFileMultipart('foto.png', 'image/png', Buffer.from('fake-png-bytes'));
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/products/${crypto.randomUUID()}/image`,
                    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': contentType },
                    payload,
                });
                expect(response.statusCode).toBe(404);
            } finally {
                await app.close();
            }
        });

        it('GET devuelve imageUrl=null para un producto sin imagen', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/products/${imageProductId}/image`,
                    headers: { authorization: `Bearer ${member.jwt}` },
                });
                expect(response.statusCode).toBe(200);
                expect(response.json().data.imageUrl).toBeNull();
            } finally {
                await app.close();
            }
        });

        it('DELETE: un member SIN manage_catalog recibe 403', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'DELETE',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/products/${imageProductId}/image`,
                    headers: { authorization: `Bearer ${member.jwt}` },
                });
                expect(response.statusCode).toBe(403);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: el owner borra la imagen', async () => {
            vi.spyOn(productImageService, 'deleteProductImage').mockResolvedValue(true);

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'DELETE',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/products/${imageProductId}/image`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(response.statusCode).toBe(200);
                expect(response.json().success).toBe(true);
            } finally {
                await app.close();
            }
        });
    });

    describe('POST /api/organizations/:id/catalogs/:catalogId/products/images/batch', () => {
        let productA: string;
        let productB: string;

        beforeAll(async () => {
            const { data: pa } = await supabaseAdmin.from('products').insert({ catalog_id: catalogId, name: 'Batch A' }).select('id').single();
            const { data: pb } = await supabaseAdmin.from('products').insert({ catalog_id: catalogId, name: 'Batch B' }).select('id').single();
            productA = pa!.id;
            productB = pb!.id;
        });

        afterAll(async () => {
            await supabaseAdmin.from('products').delete().in('id', [productA, productB]);
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('un member (solo view_catalog) puede firmar imágenes en lote', async () => {
            vi.spyOn(productImageService, 'getProductImagesBatch').mockResolvedValue({
                [productA]: { imageUrl: 'https://storage.supabase.co/signed/a.png', mimeType: 'image/png', sizeBytes: 10, uploadedAt: new Date().toISOString() },
                [productB]: { imageUrl: null, mimeType: null, sizeBytes: null, uploadedAt: null },
            });

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/products/images/batch`,
                    headers: { authorization: `Bearer ${member.jwt}` },
                    payload: { productIds: [productA, productB] },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.data.images[productA].imageUrl).toBe('https://storage.supabase.co/signed/a.png');
                expect(body.data.images[productB].imageUrl).toBeNull();
            } finally {
                await app.close();
            }
        });

        it('contraparte de rechazo: más de 100 productIds se rechaza con 400', async () => {
            const app = await buildTestApp();
            try {
                const tooMany = Array.from({ length: 101 }, () => crypto.randomUUID());
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/products/images/batch`,
                    headers: { authorization: `Bearer ${member.jwt}` },
                    payload: { productIds: tooMany },
                });
                expect(response.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('un outsider sin catalog_access recibe 404', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${outsiderOrgId}/catalogs/${catalogId}/products/images/batch`,
                    headers: { authorization: `Bearer ${outsiderOwner.jwt}` },
                    payload: { productIds: [productA] },
                });
                expect(response.statusCode).toBe(404);
            } finally {
                await app.close();
            }
        });
    });

    describe('GET/POST /api/organizations/:id/catalogs/:catalogId/import-mappings', () => {
        afterAll(async () => {
            await supabaseAdmin.from('catalog_import_mappings').delete().eq('catalog_id', catalogId);
        });

        it('un member SIN manage_catalog recibe 403 al guardar un mapeo', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import-mappings`,
                    headers: { authorization: `Bearer ${member.jwt}` },
                    payload: { name: 'Formato proveedor X', mode: 'completo', columnMapping: { sku: 'SKU', name: 'Nombre' } },
                });
                expect(response.statusCode).toBe(403);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: el owner guarda un mapeo y luego aparece en el listado', async () => {
            const app = await buildTestApp();
            try {
                const createResponse = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import-mappings`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { name: 'Formato proveedor X', mode: 'completo', columnMapping: { sku: 'SKU', name: 'Nombre' } },
                });
                expect(createResponse.statusCode).toBe(201);
                expect(createResponse.json().data.name).toBe('Formato proveedor X');

                const listResponse = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgId}/catalogs/${catalogId}/import-mappings`,
                    headers: { authorization: `Bearer ${member.jwt}` },
                });
                expect(listResponse.statusCode).toBe(200);
                const names = listResponse.json().data.map((m: { name: string }) => m.name);
                expect(names).toContain('Formato proveedor X');
            } finally {
                await app.close();
            }
        });
    });
});
