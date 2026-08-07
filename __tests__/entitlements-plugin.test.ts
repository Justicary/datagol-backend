import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { entitlementsPlugin, requireFeature } from '../src/plugins/entitlements.js';
import * as entitlementsService from '../src/services/entitlements.js';
import supabasePlugin from '../src/plugins/supabase.js';

/**
 * Pruebas dedicadas a src/plugins/entitlements.ts, aisladas de la base de
 * datos real mediante vi.spyOn sobre getOrganizationFeatures — el resto de
 * la lógica de resolución de features (plan, overrides, kill switch) ya se
 * ejercita en __tests__/entitlements.test.ts contra Supabase real. Aquí el
 * objetivo es el propio plugin: el hook onRequest y el helper requireFeature.
 */
describe('src/plugins/entitlements.ts', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    function buildApp() {
        return Fastify({ logger: false });
    }

    describe('hook onRequest — resolución de organización y features', () => {
        it('resuelve por x-organization-id: inyecta tenantId y el resultado de getOrganizationFeatures', async () => {
            const spy = vi.spyOn(entitlementsService, 'getOrganizationFeatures').mockResolvedValue(new Set(['whatsapp']));
            const app = buildApp();
            await app.register(supabasePlugin);
            await app.register(entitlementsPlugin);
            app.get('/probe', async (request, reply) => reply.send({ tenantId: request.tenantId, features: [...(request.features ?? [])] }));
            await app.ready();
            try {
                const res = await app.inject({ method: 'GET', url: '/probe', headers: { 'x-organization-id': 'org-a' } });
                expect(res.json()).toEqual({ tenantId: 'org-a', features: ['whatsapp'] });
                expect(spy).toHaveBeenCalledWith('org-a');
            } finally {
                await app.close();
            }
        });

        it('prioriza x-organization-id sobre x-tenant-id cuando ambos vienen presentes', async () => {
            const spy = vi.spyOn(entitlementsService, 'getOrganizationFeatures').mockResolvedValue(new Set());
            const app = buildApp();
            await app.register(supabasePlugin);
            await app.register(entitlementsPlugin);
            app.get('/probe', async (request, reply) => reply.send({ tenantId: request.tenantId }));
            await app.ready();
            try {
                const res = await app.inject({
                    method: 'GET',
                    url: '/probe',
                    headers: { 'x-organization-id': 'org-a', 'x-tenant-id': 'org-b' },
                });
                expect(res.json().tenantId).toBe('org-a');
                expect(spy).toHaveBeenCalledWith('org-a');
                expect(spy).not.toHaveBeenCalledWith('org-b');
            } finally {
                await app.close();
            }
        });

        it('usa x-tenant-id cuando x-organization-id está ausente', async () => {
            const spy = vi.spyOn(entitlementsService, 'getOrganizationFeatures').mockResolvedValue(new Set());
            const app = buildApp();
            await app.register(supabasePlugin);
            await app.register(entitlementsPlugin);
            app.get('/probe', async (request, reply) => reply.send({ tenantId: request.tenantId }));
            await app.ready();
            try {
                const res = await app.inject({ method: 'GET', url: '/probe', headers: { 'x-tenant-id': 'org-b' } });
                expect(res.json().tenantId).toBe('org-b');
                expect(spy).toHaveBeenCalledWith('org-b');
            } finally {
                await app.close();
            }
        });

        it('usa request.tenantId ya resuelto por un hook anterior cuando no llegan cabeceras', async () => {
            const spy = vi.spyOn(entitlementsService, 'getOrganizationFeatures').mockResolvedValue(new Set());
            const app = buildApp();
            app.addHook('onRequest', async (request) => {
                request.tenantId = 'org-preset-upstream';
            });
            await app.register(supabasePlugin);
            await app.register(entitlementsPlugin);
            app.get('/probe', async (request, reply) => reply.send({ tenantId: request.tenantId }));
            await app.ready();
            try {
                const res = await app.inject({ method: 'GET', url: '/probe' });
                expect(res.json().tenantId).toBe('org-preset-upstream');
                expect(spy).toHaveBeenCalledWith('org-preset-upstream');
            } finally {
                await app.close();
            }
        });

        it('contraparte de rechazo: sin ningún origen de organización, features queda como Set vacío y NO se consulta getOrganizationFeatures', async () => {
            const spy = vi.spyOn(entitlementsService, 'getOrganizationFeatures').mockResolvedValue(new Set(['no-deberia-verse']));
            const app = buildApp();
            await app.register(supabasePlugin);
            await app.register(entitlementsPlugin);
            app.get('/probe', async (request, reply) =>
                reply.send({
                    tenantId: request.tenantId ?? null,
                    // Distingue explícitamente "Set vacío real" de "nunca se asignó":
                    // ambos casos serían indistinguibles con un simple spread a arreglo.
                    isSet: request.features instanceof Set,
                    features: [...(request.features ?? [])],
                })
            );
            await app.ready();
            try {
                const res = await app.inject({ method: 'GET', url: '/probe' });
                expect(res.json()).toEqual({ tenantId: null, isSet: true, features: [] });
                expect(spy).not.toHaveBeenCalled();
            } finally {
                await app.close();
            }
        });
    });

    describe('requireFeature', () => {
        it('contraparte de éxito: si la feature está presente en request.features, deja pasar la petición sin responder', async () => {
            vi.spyOn(entitlementsService, 'getOrganizationFeatures').mockResolvedValue(new Set(['whatsapp']));
            const app = buildApp();
            await app.register(supabasePlugin);
            await app.register(entitlementsPlugin);
            app.get('/protected', { preHandler: [requireFeature('whatsapp')] }, async (_request, reply) => reply.send({ ok: true }));
            await app.ready();
            try {
                const res = await app.inject({ method: 'GET', url: '/protected', headers: { 'x-organization-id': 'org-a' } });
                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ ok: true });
            } finally {
                await app.close();
            }
        });

        it('rechaza con el cuerpo exacto de error 403 cuando la feature no está habilitada', async () => {
            vi.spyOn(entitlementsService, 'getOrganizationFeatures').mockResolvedValue(new Set());
            const app = buildApp();
            await app.register(supabasePlugin);
            await app.register(entitlementsPlugin);
            app.get('/protected', { preHandler: [requireFeature('whatsapp')] }, async (_request, reply) => reply.send({ ok: true }));
            await app.ready();
            try {
                const res = await app.inject({ method: 'GET', url: '/protected', headers: { 'x-organization-id': 'org-a' } });
                expect(res.statusCode).toBe(403);
                expect(res.json()).toEqual({
                    statusCode: 403,
                    error: 'Forbidden',
                    code: 'FEATURE_DISABLED',
                    message:
                        "La función 'whatsapp' no está habilitada para su organización. Contacte a soporte o actualice su plan para acceder a esta característica.",
                    requiredFeature: 'whatsapp',
                });
            } finally {
                await app.close();
            }
        });

        it('sin registrar el plugin (request.features nunca inicializado), trata la ausencia como conjunto vacío sin lanzar excepción', async () => {
            const app = buildApp();
            // Deliberadamente NO se registra entitlementsPlugin: request.features queda undefined.
            app.get('/protected-standalone', { preHandler: [requireFeature('whatsapp')] }, async (_request, reply) =>
                reply.send({ ok: true })
            );
            await app.ready();
            try {
                const res = await app.inject({ method: 'GET', url: '/protected-standalone' });
                expect(res.statusCode).toBe(403);
                expect(res.json().code).toBe('FEATURE_DISABLED');
            } finally {
                await app.close();
            }
        });
    });
});
