import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { availabilityToolRoute } from '../src/routes/tools/availability.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';

vi.mock('../src/services/cal-com-tool-client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/services/cal-com-tool-client.js')>();
    return { ...actual, getAvailableSlots: vi.fn() };
});

import { getAvailableSlots, CalProviderError } from '../src/services/cal-com-tool-client.js';
import { ToolTimeoutError } from '../src/lib/tool-timeout.js';

// Organización real existente (ver __tests__/entitlements.test.ts). Ya tiene
// cal_event_type_id configurado en producción — no requiere prepararlo aquí.
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';
const TEST_TOOL_SECRET = 'availability-route-test-secret';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(availabilityToolRoute);
    await app.ready();
    return app;
}

describe('POST /tools/:webhookToken/availability', () => {
    const TEST_WEBHOOK_TOKEN = `avail-test-token-${Date.now()}`;

    beforeAll(async () => {
        const { error: orgErr } = await supabaseAdmin.from('organizations').update({ webhook_token: TEST_WEBHOOK_TOKEN }).eq('id', REAL_ORG_ID);
        if (orgErr) throw new Error(`No se pudo preparar webhook_token: ${orgErr.message}`);

        const saved = await setSecret(REAL_ORG_ID, SECRET_KEYS.TOOL_WEBHOOK_SECRET, TEST_TOOL_SECRET);
        if (!saved) throw new Error('No se pudo guardar tool_webhook_secret de prueba');
        clearSecretCache(REAL_ORG_ID);
    });

    afterAll(async () => {
        await supabaseAdmin.from('organizations').update({ webhook_token: null }).eq('id', REAL_ORG_ID);
        await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', REAL_ORG_ID).eq('secret_key', SECRET_KEYS.TOOL_WEBHOOK_SECRET);
        clearSecretCache(REAL_ORG_ID);
    });

    beforeEach(() => {
        vi.mocked(getAvailableSlots).mockReset();
    });

    it('rechaza con 401 cuando el webhookToken no resuelve a ninguna organización', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/tools/token-inexistente/availability',
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { startTime: '2026-09-01T00:00:00Z', endTime: '2026-09-02T00:00:00Z' },
            });
            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('rechaza con 401 cuando x-tool-secret está ausente, aunque el webhookToken sea válido', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/availability`,
                payload: { startTime: '2026-09-01T00:00:00Z', endTime: '2026-09-02T00:00:00Z' },
            });
            expect(response.statusCode).toBe(401);
            expect(vi.mocked(getAvailableSlots)).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('rechaza con 400 cuando falta un campo obligatorio del cuerpo', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/availability`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { startTime: '2026-09-01T00:00:00Z' },
            });
            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('rechaza con 403 Forbidden cuando la organización está suspendida', async () => {
        await supabaseAdmin.from('organizations').update({ status: 'suspended', suspended_reason: 'Prueba de suspensión' }).eq('id', REAL_ORG_ID);
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/availability`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { startTime: '2026-09-01T00:00:00Z', endTime: '2026-09-02T00:00:00Z' },
            });
            expect(response.statusCode).toBe(403);
            expect(response.json().error).toBe('Forbidden');
            expect(vi.mocked(getAvailableSlots)).not.toHaveBeenCalled();
        } finally {
            await supabaseAdmin.from('organizations').update({ status: 'active', suspended_reason: null, suspended_at: null }).eq('id', REAL_ORG_ID);
            await app.close();
        }
    });

    it('contraparte de éxito: token y secreto válidos devuelven disponibilidad truncada a un máximo de dos horarios', async () => {
        vi.mocked(getAvailableSlots).mockResolvedValue([
            { time: '2026-09-01T10:00:00Z' },
            { time: '2026-09-01T11:00:00Z' },
            { time: '2026-09-01T12:00:00Z' },
        ]);

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/availability`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { startTime: '2026-09-01T00:00:00Z', endTime: '2026-09-02T00:00:00Z' },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.available).toBe(true);
            expect(body.slots).toHaveLength(2);
            expect(body.slots).toEqual(['2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z']);
        } finally {
            await app.close();
        }
    });

    it('degradación: si Cal.com excede el timeout, responde 200 con un mensaje verbalizable en vez de fallar', async () => {
        vi.mocked(getAvailableSlots).mockRejectedValue(new ToolTimeoutError(400));

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/availability`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { startTime: '2026-09-01T00:00:00Z', endTime: '2026-09-02T00:00:00Z' },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.available).toBe(false);
            expect(body.slots).toEqual([]);
            expect(typeof body.message).toBe('string');
            expect(body.message.length).toBeGreaterThan(0);
        } finally {
            await app.close();
        }
    });

    it('degradación: si Cal.com responde error de proveedor, responde 200 con un mensaje verbalizable en vez de un 500', async () => {
        vi.mocked(getAvailableSlots).mockRejectedValue(new CalProviderError(503, 'Cal.com no disponible'));

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/availability`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: { startTime: '2026-09-01T00:00:00Z', endTime: '2026-09-02T00:00:00Z' },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.available).toBe(false);
        } finally {
            await app.close();
        }
    });
});
