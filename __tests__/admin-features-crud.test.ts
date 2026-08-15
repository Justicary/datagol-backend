import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import adminFeaturesRoutes from '../src/routes/admin/features.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { clearEntitlementsCache } from '../src/services/entitlements.js';
import { ALL_FEATURE_CATEGORIES } from '../src/types/feature-taxonomy.js';

const TEST_FEATURE_KEY = `test_crud_feat_${Date.now()}`;
const TEST_FEATURE_KEY_2 = `test_crud_feat_no_plans_${Date.now()}`;

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(adminFeaturesRoutes);
    await app.ready();
    return app;
}

describe('CRUD de Features Administrativo (/api/admin/features)', () => {
    let existingPlanKeys: string[] = [];

    beforeAll(async () => {
        const { data: plans } = await supabaseAdmin.from('plans').select('key');
        existingPlanKeys = (plans ?? []).map((p) => p.key);
    });

    afterAll(async () => {
        // Limpieza de datos de prueba
        await supabaseAdmin.from('plan_features').delete().in('feature_key', [TEST_FEATURE_KEY, TEST_FEATURE_KEY_2]);
        await supabaseAdmin.from('features').delete().in('key', [TEST_FEATURE_KEY, TEST_FEATURE_KEY_2]);
        clearEntitlementsCache();
    });

    describe('GET /api/admin/features', () => {
        it('rechaza 401 si no se envía autenticación de plataforma', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: '/api/admin/features',
                });
                expect(response.statusCode).toBe(401);
            } finally {
                await app.close();
            }
        });

        it('retorna la lista completa de características ordenadas por sort_order con sus planes asociados (plans: string[])', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: '/api/admin/features',
                    headers: { 'x-platform-admin': 'true' },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body).toHaveProperty('data');
                expect(Array.isArray(body.data)).toBe(true);
                expect(body.data.length).toBeGreaterThan(0);

                const first = body.data[0];
                expect(first).toHaveProperty('key');
                expect(first).toHaveProperty('name');
                expect(first).toHaveProperty('category');
                expect(first).toHaveProperty('sort_order');
                expect(first).toHaveProperty('plans');
                expect(Array.isArray(first.plans)).toBe(true);

                // Verificar orden ascendente por sort_order
                for (let i = 1; i < body.data.length; i++) {
                    expect(body.data[i].sort_order).toBeGreaterThanOrEqual(body.data[i - 1].sort_order);
                }
            } finally {
                await app.close();
            }
        });
    });

    describe('POST /api/admin/features (Upsert)', () => {
        it('rechaza 401 si no se envía autenticación de plataforma', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/admin/features',
                    payload: {
                        key: TEST_FEATURE_KEY,
                        name: 'Feature de Prueba',
                        category: ALL_FEATURE_CATEGORIES[0],
                    },
                });
                expect(response.statusCode).toBe(401);
            } finally {
                await app.close();
            }
        });

        it('rechaza 400 si falta el campo "key"', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/admin/features',
                    headers: { 'x-platform-admin': 'true' },
                    payload: {
                        name: 'Feature sin key',
                        category: ALL_FEATURE_CATEGORIES[0],
                    },
                });
                expect(response.statusCode).toBe(400);
                const body = response.json();
                expect(body.error).toBe('BadRequest');
            } finally {
                await app.close();
            }
        });

        it('rechaza 400 si el formato de "key" no es snake_case', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/admin/features',
                    headers: { 'x-platform-admin': 'true' },
                    payload: {
                        key: 'INVALID KEY WITH SPACES',
                        name: 'Feature inválida',
                        category: ALL_FEATURE_CATEGORIES[0],
                    },
                });
                expect(response.statusCode).toBe(400);
                const body = response.json();
                expect(body.error).toBe('BadRequest');
                expect(body.message).toContain('snake_case');
            } finally {
                await app.close();
            }
        });

        it('rechaza 400 si "category" no es válida', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/admin/features',
                    headers: { 'x-platform-admin': 'true' },
                    payload: {
                        key: 'feature_cat_invalida',
                        name: 'Feature con categoría inválida',
                        category: 'categoria_inexistente_xyz',
                    },
                });
                expect(response.statusCode).toBe(400);
                const body = response.json();
                expect(body.error).toBe('BadRequest');
            } finally {
                await app.close();
            }
        });

        it('rechaza 400 si "sort_order" es negativo', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/admin/features',
                    headers: { 'x-platform-admin': 'true' },
                    payload: {
                        key: 'feature_sort_negativo',
                        name: 'Feature con sort negativo',
                        category: ALL_FEATURE_CATEGORIES[0],
                        sort_order: -5,
                    },
                });
                expect(response.statusCode).toBe(400);
                const body = response.json();
                expect(body.error).toBe('BadRequest');
            } finally {
                await app.close();
            }
        });

        it('rechaza 400 si se envía un plan inexistente en "plans"', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/admin/features',
                    headers: { 'x-platform-admin': 'true' },
                    payload: {
                        key: TEST_FEATURE_KEY,
                        name: 'Feature con plan inválido',
                        category: ALL_FEATURE_CATEGORIES[0],
                        plans: ['plan_totalmente_ficticio_xyz'],
                    },
                });
                expect(response.statusCode).toBe(400);
                const body = response.json();
                expect(body.error).toBe('BadRequest');
                expect(body.message).toContain('no existe en el catálogo de planes');
            } finally {
                await app.close();
            }
        });

        it('crea exitosamente una nueva feature y asocia los planes indicados en plan_features', async () => {
            const app = await buildTestApp();
            try {
                const selectedPlans = existingPlanKeys.slice(0, 2);
                expect(selectedPlans.length).toBeGreaterThan(0);

                const response = await app.inject({
                    method: 'POST',
                    url: '/api/admin/features',
                    headers: { 'x-platform-admin': 'true' },
                    payload: {
                        key: TEST_FEATURE_KEY,
                        name: 'Notificaciones WhatsApp Avanzadas',
                        description: 'Permite envío de recordatorios y confirmaciones vía WhatsApp API.',
                        category: 'mensajeria',
                        requires_provider: 'meta',
                        has_cost_impact: true,
                        sort_order: 999,
                        plans: selectedPlans,
                    },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body).toHaveProperty('data');
                expect(body.data.key).toBe(TEST_FEATURE_KEY);
                expect(body.data.name).toBe('Notificaciones WhatsApp Avanzadas');
                expect(body.data.category).toBe('mensajeria');
                expect(body.data.requires_provider).toBe('meta');
                expect(body.data.has_cost_impact).toBe(true);
                expect(body.data.sort_order).toBe(999);
                expect(body.data.plans).toEqual(expect.arrayContaining(selectedPlans));

                // Verificar en plan_features que los planes seleccionados están con enabled=true y los no seleccionados con enabled=false
                const { data: pfRows } = await supabaseAdmin
                    .from('plan_features')
                    .select('plan_key, enabled')
                    .eq('feature_key', TEST_FEATURE_KEY);

                expect(pfRows).toBeDefined();
                expect(pfRows!.length).toBe(existingPlanKeys.length);

                for (const row of pfRows!) {
                    if (selectedPlans.includes(row.plan_key)) {
                        expect(row.enabled).toBe(true);
                    } else {
                        expect(row.enabled).toBe(false);
                    }
                }

                // Verificar que GET /api/admin/features devuelve la feature con sus planes
                const getResponse = await app.inject({
                    method: 'GET',
                    url: '/api/admin/features',
                    headers: { 'x-platform-admin': 'true' },
                });
                expect(getResponse.statusCode).toBe(200);
                const getBody = getResponse.json();
                const found = getBody.data.find((f: any) => f.key === TEST_FEATURE_KEY);
                expect(found).toBeDefined();
                expect(found.name).toBe('Notificaciones WhatsApp Avanzadas');
                expect(found.plans).toEqual(expect.arrayContaining(selectedPlans));
            } finally {
                await app.close();
            }
        });

        it('actualiza (upsert) una feature existente modificando campos y cambiando los planes asociados', async () => {
            const app = await buildTestApp();
            try {
                // Seleccionar un conjunto diferente de planes
                const newSelectedPlans = existingPlanKeys.slice(1, 3);

                const response = await app.inject({
                    method: 'POST',
                    url: '/api/admin/features',
                    headers: { 'x-platform-admin': 'true' },
                    payload: {
                        key: TEST_FEATURE_KEY,
                        name: 'Notificaciones WhatsApp (Actualizado)',
                        description: 'Descripción actualizada con soporte de plantillas multimedia.',
                        category: 'mensajeria',
                        requires_provider: 'meta',
                        has_cost_impact: false,
                        sort_order: 1000,
                        plans: newSelectedPlans,
                    },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.data.name).toBe('Notificaciones WhatsApp (Actualizado)');
                expect(body.data.has_cost_impact).toBe(false);
                expect(body.data.sort_order).toBe(1000);
                expect(body.data.plans).toEqual(expect.arrayContaining(newSelectedPlans));

                // Verificar en plan_features
                const { data: pfRows } = await supabaseAdmin
                    .from('plan_features')
                    .select('plan_key, enabled')
                    .eq('feature_key', TEST_FEATURE_KEY);

                for (const row of pfRows!) {
                    if (newSelectedPlans.includes(row.plan_key)) {
                        expect(row.enabled).toBe(true);
                    } else {
                        expect(row.enabled).toBe(false);
                    }
                }
            } finally {
                await app.close();
            }
        });

        it('crea exitosamente una feature sin el campo plans (plans queda opcional)', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/admin/features',
                    headers: { 'x-platform-admin': 'true' },
                    payload: {
                        key: TEST_FEATURE_KEY_2,
                        name: 'Feature Base Plataforma',
                        category: 'plataforma',
                        sort_order: 10,
                    },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.data.key).toBe(TEST_FEATURE_KEY_2);
                expect(body.data.name).toBe('Feature Base Plataforma');
                expect(body.data.category).toBe('plataforma');
                expect(body.data.plans).toEqual([]);
            } finally {
                await app.close();
            }
        });
    });
});
