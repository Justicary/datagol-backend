import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import organizationJevRoutes from '../src/routes/organization-jev.js';
import * as organizationAuth from '../src/lib/organization-auth.js';
import * as permissionService from '../src/services/permission-service.js';
import * as jevConfigService from '../src/services/jev-config-service.js';
import { PERMISSION_KEYS } from '../src/types/permission-keys.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const EMPTY_CONFIG = { model: null, validatedAt: null, lastError: null };

/**
 * Pruebas de las rutas HTTP de Jev con autenticación, permisos y servicio
 * sustituidos: cubren el contrato HTTP (status, forma de respuesta, RBAC y
 * validación de body). La lógica de validación contra OpenRouter se prueba en
 * jev-config-service.test.ts y jev-openrouter-key-client.test.ts.
 */
async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(organizationJevRoutes);
    await app.ready();
    return app;
}

function grantPermissions(keys: string[]) {
    vi.spyOn(permissionService, 'getPermissionsForUser').mockResolvedValue(new Set(keys) as never);
}

describe('routes/organization-jev.ts', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
        vi.spyOn(organizationAuth, 'requireAuthenticatedUser').mockResolvedValue({ userId: 'user-1', jwt: 'jwt' } as never);
        app = await buildTestApp();
    });

    afterEach(async () => {
        await app.close();
        vi.restoreAllMocks();
    });

    describe('autorización', () => {
        it('400 si :id no es UUID (no consulta permisos)', async () => {
            const permSpy = vi.spyOn(permissionService, 'getPermissionsForUser');
            const res = await app.inject({ method: 'GET', url: '/api/organizations/no-uuid/jev-config' });
            expect(res.statusCode).toBe(400);
            expect(res.json()).toEqual({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
            expect(permSpy).not.toHaveBeenCalled();
        });

        it('sin sesión: la ruta no continúa (requireAuthenticatedUser ya respondió 401)', async () => {
            vi.mocked(organizationAuth.requireAuthenticatedUser).mockImplementation(async (_f, _req, reply) => {
                reply.status(401).send({ success: false, error: 'Unauthorized' });
                return null;
            });
            const permSpy = vi.spyOn(permissionService, 'getPermissionsForUser');
            const getSpy = vi.spyOn(jevConfigService, 'getJevConfig');
            const res = await app.inject({ method: 'GET', url: `/api/organizations/${ORG_ID}/jev-config` });
            expect(res.statusCode).toBe(401);
            expect(permSpy).not.toHaveBeenCalled();
            expect(getSpy).not.toHaveBeenCalled();
        });

        it.each([
            ['GET', 'jev-config'],
            ['PATCH', 'jev-config'],
            ['POST', 'jev/validate'],
        ] as const)('%s /%s → 403 sin manage_credentials, sin tocar el servicio', async (method, path) => {
            grantPermissions([]);
            const getSpy = vi.spyOn(jevConfigService, 'getJevConfig');
            const updateSpy = vi.spyOn(jevConfigService, 'updateJevConfig');
            const validateSpy = vi.spyOn(jevConfigService, 'validateJevCredentials');

            const res = await app.inject({
                method,
                url: `/api/organizations/${ORG_ID}/${path}`,
                payload: method === 'PATCH' ? { model: '~typesafe/jev-latest' } : undefined,
            });

            expect(res.statusCode).toBe(403);
            expect(res.json()).toEqual({
                success: false,
                error: 'Forbidden',
                code: 'PERMISSION_DENIED',
                message: `No tiene el permiso "${PERMISSION_KEYS.MANAGE_CREDENTIALS}" en esta organización, o no pertenece a ella.`,
                requiredPermission: PERMISSION_KEYS.MANAGE_CREDENTIALS,
            });
            expect(getSpy).not.toHaveBeenCalled();
            expect(updateSpy).not.toHaveBeenCalled();
            expect(validateSpy).not.toHaveBeenCalled();
        });
    });

    describe('con manage_credentials', () => {
        beforeEach(() => {
            grantPermissions([PERMISSION_KEYS.MANAGE_CREDENTIALS]);
        });

        it('GET /jev-config devuelve la configuración de la organización de la ruta', async () => {
            const config = { model: '~typesafe/jev-latest', validatedAt: '2026-09-01T00:00:00.000Z', lastError: null };
            const getSpy = vi.spyOn(jevConfigService, 'getJevConfig').mockResolvedValue(config);

            const res = await app.inject({ method: 'GET', url: `/api/organizations/${ORG_ID}/jev-config` });

            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ success: true, data: config });
            expect(getSpy).toHaveBeenCalledWith(expect.anything(), ORG_ID);
        });

        it.each([
            [{}],
            [{ model: '' }],
            [{ model: 'sin-autor' }],
            [{ model: 'typesafe/jev latest' }],
            [{ model: 42 }],
        ])('PATCH /jev-config con body inválido %j → 400 sin guardar', async (payload) => {
            const updateSpy = vi.spyOn(jevConfigService, 'updateJevConfig');
            const res = await app.inject({ method: 'PATCH', url: `/api/organizations/${ORG_ID}/jev-config`, payload });
            expect(res.statusCode).toBe(400);
            expect(res.json()).toEqual({
                success: false,
                error: 'Cuerpo de la petición inválido: se requiere "model" con la forma "autor/modelo" de OpenRouter.',
            });
            expect(updateSpy).not.toHaveBeenCalled();
        });

        it.each(['~typesafe/jev-latest', 'typesafe/jev', 'typesafe/jev-1.0:beta'])(
            'contraparte de éxito: PATCH /jev-config con model "%s" → 200 y lo guarda',
            async (model) => {
                const updateSpy = vi.spyOn(jevConfigService, 'updateJevConfig').mockResolvedValue({ success: true });
                vi.spyOn(jevConfigService, 'getJevConfig').mockResolvedValue({ ...EMPTY_CONFIG, model });

                const res = await app.inject({ method: 'PATCH', url: `/api/organizations/${ORG_ID}/jev-config`, payload: { model } });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ success: true, data: { ...EMPTY_CONFIG, model } });
                expect(updateSpy).toHaveBeenCalledWith(expect.anything(), ORG_ID, { model });
            }
        );

        it('PATCH /jev-config → 500 si el servicio no pudo guardar', async () => {
            vi.spyOn(jevConfigService, 'updateJevConfig').mockResolvedValue({ success: false, error: 'No se pudo guardar la configuración de Jev.' });
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${ORG_ID}/jev-config`,
                payload: { model: '~typesafe/jev-latest' },
            });
            expect(res.statusCode).toBe(500);
            expect(res.json()).toEqual({ success: false, error: 'No se pudo guardar la configuración de Jev.' });
        });

        it('POST /jev/validate → 422 con kind y mensaje accionable cuando falla', async () => {
            vi.spyOn(jevConfigService, 'validateJevCredentials').mockResolvedValue({
                success: false,
                kind: 'invalid_key',
                error: 'La llave de OpenRouter no es válida.',
            });
            const res = await app.inject({ method: 'POST', url: `/api/organizations/${ORG_ID}/jev/validate` });
            expect(res.statusCode).toBe(422);
            expect(res.json()).toEqual({ success: false, kind: 'invalid_key', error: 'La llave de OpenRouter no es válida.' });
        });

        it('contraparte de éxito: POST /jev/validate → 200 con validatedAt', async () => {
            const validatedAt = '2026-09-24T12:00:00.000Z';
            const validateSpy = vi.spyOn(jevConfigService, 'validateJevCredentials').mockResolvedValue({ success: true, validatedAt });
            const res = await app.inject({ method: 'POST', url: `/api/organizations/${ORG_ID}/jev/validate` });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ success: true, data: { validatedAt } });
            expect(validateSpy).toHaveBeenCalledWith(expect.anything(), ORG_ID);
        });
    });
});
