import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationRoutes from '../src/routes/organization.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(organizationRoutes);
    await app.ready();
    return app;
}

describe('GET /api/organizations/:id/public-profile', () => {
    it('responde 200 sin ningún header de autenticación (pública a propósito, no un descuido)', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/api/organizations/${REAL_ORG_ID}/public-profile`,
            });
            expect(response.statusCode).toBe(200);
        } finally {
            await app.close();
        }
    });

    it('la respuesta nunca incluye columnas fuera de la whitelist (credenciales, webhook_token, status, suspended_reason)', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/api/organizations/${REAL_ORG_ID}/public-profile`,
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();

            expect(Object.keys(body.data).sort()).toEqual(['address', 'city', 'email', 'name', 'state'].sort());
            expect(body.data).not.toHaveProperty('elevenlabs_api_key');
            expect(body.data).not.toHaveProperty('telnyx_api_key');
            expect(body.data).not.toHaveProperty('whatsapp_access_token');
            expect(body.data).not.toHaveProperty('cal_api_key');
            expect(body.data).not.toHaveProperty('webhook_token');
            expect(body.data).not.toHaveProperty('status');
            expect(body.data).not.toHaveProperty('suspended_reason');
            expect(body.data).not.toHaveProperty('phone_number');
        } finally {
            await app.close();
        }
    });

    it('404 cuando el id no existe (UUID válido pero sin fila)', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: '/api/organizations/00000000-0000-0000-0000-000000000001/public-profile',
            });
            expect(response.statusCode).toBe(404);
            expect(response.json().error).toBe('NotFound');
        } finally {
            await app.close();
        }
    });

    it('404 con el mismo mensaje cuando el id no es un UUID válido (no revela cuál caso es)', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: '/api/organizations/id-no-es-un-uuid/public-profile',
            });
            expect(response.statusCode).toBe(404);
            expect(response.json().error).toBe('NotFound');
        } finally {
            await app.close();
        }
    });
});
