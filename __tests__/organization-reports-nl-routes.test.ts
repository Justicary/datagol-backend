import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationReportsRoutes from '../src/routes/organization-reports.js';
import adminReportsRoutes from '../src/routes/admin/reports.js';
import * as orgAuth from '../src/lib/organization-auth.js';
import * as permissionService from '../src/services/permission-service.js';
import { PERMISSION_KEYS } from '../src/types/permission-keys.js';
import * as nlReportsService from '../src/services/reports/nl-reports-service.js';
import * as unansweredService from '../src/services/reports/unanswered-questions-service.js';

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(organizationReportsRoutes);
    await app.register(adminReportsRoutes);
    await app.ready();
    return app;
}

describe('Rutas HTTP de Reportes en Lenguaje Natural', () => {
    let app: FastifyInstance;
    const orgId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const userId = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';

    beforeAll(async () => {
        app = await buildTestApp();
    });

    afterAll(async () => {
        await app.close();
    });

    describe('POST /api/organizations/:id/reports/ask', () => {
        it('rechaza con 400 si el parámetro id no es un UUID válido', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/organizations/invalid-uuid/reports/ask',
                payload: { question: '¿cuántas citas hay?' },
                headers: { authorization: 'Bearer mock-jwt' },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().error).toContain('UUID válido');
        });

        it('rechaza con 401 si no hay token de autenticación', async () => {
            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/reports/ask`,
                payload: { question: '¿cuántas citas hay?' },
            });
            expect(res.statusCode).toBe(401);
        });

        it('rechaza con 403 si el usuario no tiene el permiso use_nl_reports (ej. un member)', async () => {
            vi.spyOn(orgAuth, 'requireAuthenticatedUser').mockResolvedValue({ userId, jwt: 'mock-jwt' });
            vi.spyOn(permissionService, 'getPermissionsForUser').mockResolvedValue(new Set(['view_contacts']));

            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/reports/ask`,
                payload: { question: '¿cuántas citas hay?' },
                headers: { authorization: 'Bearer mock-jwt' },
            });
            expect(res.statusCode).toBe(403);
            expect(res.json().requiredPermission).toBe(PERMISSION_KEYS.USE_NL_REPORTS);
        });

        it('rechaza con 400 si la pregunta está vacía', async () => {
            vi.spyOn(orgAuth, 'requireAuthenticatedUser').mockResolvedValue({ userId, jwt: 'mock-jwt' });
            vi.spyOn(permissionService, 'getPermissionsForUser').mockResolvedValue(new Set([PERMISSION_KEYS.USE_NL_REPORTS]));

            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/reports/ask`,
                payload: { question: '   ' },
                headers: { authorization: 'Bearer mock-jwt' },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().error).toContain('La pregunta no puede estar vacía');
        });

        it('responde 200 con el resultado estructurado de askReport', async () => {
            vi.spyOn(orgAuth, 'requireAuthenticatedUser').mockResolvedValue({ userId, jwt: 'mock-jwt' });
            vi.spyOn(permissionService, 'getPermissionsForUser').mockResolvedValue(new Set([PERMISSION_KEYS.USE_NL_REPORTS]));

            vi.spyOn(nlReportsService, 'askReport').mockResolvedValue({
                success: true,
                status: 'success',
                intent: 'conteo_citas',
                category: 'agenda',
                interpretation: 'Conteo de citas del mes',
                period: {
                    type: 'este_mes',
                    startUtc: '2026-08-01T06:00:00.000Z',
                    endUtc: '2026-08-31T06:00:00.000Z',
                    startLocal: '2026-08-01',
                    endLocal: '2026-08-31',
                    label: 'Este mes (agosto 2026)',
                    timezone: 'America/Mexico_City',
                },
                shape: 'numero',
                data: { total: 42 },
                narrative: 'Este mes se registraron 42 citas en total.',
                warnings: [],
                executionTimeMs: 450,
            });

            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/reports/ask`,
                payload: { question: '¿Cuántas citas tengo este mes?' },
                headers: { authorization: 'Bearer mock-jwt' },
            });

            expect(res.statusCode).toBe(200);
            const json = res.json();
            expect(json.success).toBe(true);
            expect(json.status).toBe('success');
            expect(json.intent).toBe('conteo_citas');
            expect(json.data.total).toBe(42);
        });

        it('maneja NaturalReportsError con el código de estado adecuado (ej. 403 o 429)', async () => {
            vi.spyOn(orgAuth, 'requireAuthenticatedUser').mockResolvedValue({ userId, jwt: 'mock-jwt' });
            vi.spyOn(permissionService, 'getPermissionsForUser').mockResolvedValue(new Set([PERMISSION_KEYS.USE_NL_REPORTS]));

            vi.spyOn(nlReportsService, 'askReport').mockRejectedValue(
                new nlReportsService.NaturalReportsError('Límite de tasa excedido.', 429)
            );

            const res = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/reports/ask`,
                payload: { question: '¿Cuántas citas tengo?' },
                headers: { authorization: 'Bearer mock-jwt' },
            });

            expect(res.statusCode).toBe(429);
            expect(res.json().error).toContain('Límite de tasa excedido');
        });
    });

    describe('GET /api/organizations/:id/reports/unanswered-questions', () => {
        it('lista preguntas no resueltas de la organización para admin/owner', async () => {
            vi.spyOn(orgAuth, 'requireAuthenticatedUser').mockResolvedValue({ userId, jwt: 'mock-jwt' });
            vi.spyOn(orgAuth, 'requireOrganizationMembership').mockResolvedValue(true);
            vi.spyOn(orgAuth, 'requireOrganizationRole').mockResolvedValue(true);

            vi.spyOn(unansweredService, 'listUnansweredQuestions').mockResolvedValue([
                {
                    id: 'q-1',
                    organization_id: orgId,
                    question: '¿cuánto inventario queda?',
                    reason: 'no_resuelta',
                    metadata: {},
                    created_at: '2026-08-18T12:00:00Z',
                },
            ]);

            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/reports/unanswered-questions`,
                headers: { authorization: 'Bearer mock-jwt' },
            });

            expect(res.statusCode).toBe(200);
            expect(res.json().data).toHaveLength(1);
            expect(res.json().data[0].question).toBe('¿cuánto inventario queda?');
        });
    });

    describe('GET /api/admin/reports/unanswered-questions & /summary', () => {
        it('permite a platform_admin consultar todas las preguntas no resueltas', async () => {
            vi.spyOn(unansweredService, 'listUnansweredQuestions').mockResolvedValue([
                {
                    id: 'q-global',
                    organization_id: orgId,
                    question: '¿quién es mi mejor cliente?',
                    reason: 'no_resuelta',
                    metadata: {},
                    created_at: '2026-08-18T12:00:00Z',
                },
            ]);

            const res = await app.inject({
                method: 'GET',
                url: '/api/admin/reports/unanswered-questions',
                headers: { 'x-platform-admin': 'true' },
            });

            expect(res.statusCode).toBe(200);
            expect(res.json().data).toHaveLength(1);
        });

        it('obtiene resumen agregado de preguntas para guiar la v2', async () => {
            vi.spyOn(unansweredService, 'getUnansweredQuestionsSummary').mockResolvedValue({
                total: 10,
                porRazon: { no_resuelta: 8, requiere_aclaracion: 2, error: 0 },
                preguntasFrecuentes: [{ question: '¿cómo voy?', total: 5, reason: 'requiere_aclaracion' }],
            });

            const res = await app.inject({
                method: 'GET',
                url: '/api/admin/reports/unanswered-questions/summary',
                headers: { 'x-platform-admin': 'true' },
            });

            expect(res.statusCode).toBe(200);
            expect(res.json().data.total).toBe(10);
            expect(res.json().data.preguntasFrecuentes).toHaveLength(1);
        });
    });
});
