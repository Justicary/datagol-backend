import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { widgetRoutes } from '../src/routes/widget.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, getSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { clearEntitlementsCache } from '../src/services/entitlements.js';
import { FEATURE_KEYS } from '../src/types/feature-taxonomy.js';
import { ElevenLabsAdapter } from '../src/services/providers/ElevenLabsAdapter.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';
const TEST_ORIGIN = 'https://widget-test.example.com';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(widgetRoutes);
    await app.ready();
    return app;
}

/**
 * `ElevenLabsAdapter` se instancia una sola vez como singleton de módulo en
 * services/widget-session.ts — el mock debe vivir en el prototipo para
 * interceptar esa instancia ya construida (mismo criterio documentado en
 * __tests__/voice-outbound.test.ts para VoiceProviderFactory).
 */
function mockGetSignedUrl(impl: () => Promise<{ signedUrl: string }>) {
    return vi.spyOn(ElevenLabsAdapter.prototype, 'getSignedUrl').mockImplementation(impl);
}

describe('POST /api/widget/session', () => {
    const publicKey = `pk_test_${Date.now()}`;
    let originalAgentId: string | null = null;
    let originalDailyLimit: number | null = null;
    let originalApiKey: string | null = null;

    beforeAll(async () => {
        const { data: before } = await supabaseAdmin
            .from('organizations')
            .select('elevenlabs_agent_id, widget_daily_session_limit')
            .eq('id', REAL_ORG_ID)
            .maybeSingle();
        originalAgentId = before?.elevenlabs_agent_id ?? null;
        originalDailyLimit = before?.widget_daily_session_limit ?? null;
        originalApiKey = await getSecret(REAL_ORG_ID, SECRET_KEYS.ELEVENLABS_API_KEY);

        const { error: orgErr } = await supabaseAdmin
            .from('organizations')
            .update({ elevenlabs_agent_id: 'agent_test_widget' })
            .eq('id', REAL_ORG_ID);
        if (orgErr) throw new Error(`No se pudo preparar elevenlabs_agent_id: ${orgErr.message}`);

        const saved = await setSecret(REAL_ORG_ID, SECRET_KEYS.ELEVENLABS_API_KEY, 'test-elevenlabs-key');
        if (!saved) throw new Error('No se pudo guardar elevenlabs_api_key de prueba');
        clearSecretCache(REAL_ORG_ID);

        const { error: originErr } = await supabaseAdmin.from('widget_origins').insert({
            organization_id: REAL_ORG_ID,
            origin: TEST_ORIGIN,
            public_key: publicKey,
            enabled: true,
        });
        if (originErr) throw new Error(`No se pudo preparar widget_origins: ${originErr.message}`);

        await supabaseAdmin
            .from('organization_features')
            .upsert(
                { organization_id: REAL_ORG_ID, feature_key: FEATURE_KEYS.WEB_WIDGET, enabled: true, reason: 'widget-session.test.ts' },
                { onConflict: 'organization_id,feature_key' }
            );
        clearEntitlementsCache(REAL_ORG_ID);
    });

    afterAll(async () => {
        await supabaseAdmin.from('widget_origins').delete().eq('public_key', publicKey);
        await supabaseAdmin
            .from('organization_features')
            .delete()
            .eq('organization_id', REAL_ORG_ID)
            .eq('feature_key', FEATURE_KEYS.WEB_WIDGET);
        await supabaseAdmin
            .from('organizations')
            .update({ elevenlabs_agent_id: originalAgentId, widget_daily_session_limit: originalDailyLimit ?? 200 })
            .eq('id', REAL_ORG_ID);

        if (originalApiKey !== null) {
            await setSecret(REAL_ORG_ID, SECRET_KEYS.ELEVENLABS_API_KEY, originalApiKey);
        } else {
            await supabaseAdmin
                .from('organization_secrets')
                .delete()
                .eq('organization_id', REAL_ORG_ID)
                .eq('secret_key', SECRET_KEYS.ELEVENLABS_API_KEY);
        }
        clearSecretCache(REAL_ORG_ID);
        clearEntitlementsCache(REAL_ORG_ID);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await supabaseAdmin.from('widget_session_attempts').delete().eq('organization_id', REAL_ORG_ID);
    });

    it('rechaza con 400 cuando falta publicKey en el cuerpo', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/widget/session',
                headers: { origin: TEST_ORIGIN },
                payload: {},
            });
            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('rechaza con 400 cuando falta el encabezado Origin, aunque la publicKey sea válida', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/widget/session',
                payload: { publicKey },
            });
            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('rechaza con 403 cuando la publicKey no resuelve a ningún origen registrado', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/widget/session',
                headers: { origin: TEST_ORIGIN },
                payload: { publicKey: 'pk_inexistente_xyz' },
            });
            expect(response.statusCode).toBe(403);
        } finally {
            await app.close();
        }
    });

    it('rechaza con 403 cuando el Origin no coincide con el registrado para esa publicKey', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/widget/session',
                headers: { origin: 'https://origen-no-autorizado.example.com' },
                payload: { publicKey },
            });
            expect(response.statusCode).toBe(403);
        } finally {
            await app.close();
        }
    });

    it('rechaza con 403 FEATURE_DISABLED cuando la organización no tiene el entitlement web_widget', async () => {
        await supabaseAdmin
            .from('organization_features')
            .upsert(
                { organization_id: REAL_ORG_ID, feature_key: FEATURE_KEYS.WEB_WIDGET, enabled: false, reason: 'test disabled' },
                { onConflict: 'organization_id,feature_key' }
            );
        clearEntitlementsCache(REAL_ORG_ID);

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/widget/session',
                headers: { origin: TEST_ORIGIN },
                payload: { publicKey },
            });
            expect(response.statusCode).toBe(403);
            expect(response.json().code).toBe('FEATURE_DISABLED');
        } finally {
            await supabaseAdmin
                .from('organization_features')
                .upsert(
                    { organization_id: REAL_ORG_ID, feature_key: FEATURE_KEYS.WEB_WIDGET, enabled: true, reason: 'restore' },
                    { onConflict: 'organization_id,feature_key' }
                );
            clearEntitlementsCache(REAL_ORG_ID);
            await app.close();
        }
    });

    it('rechaza con 403 cuando la organización está suspendida', async () => {
        await supabaseAdmin
            .from('organizations')
            .update({ status: 'suspended', suspended_reason: 'Prueba de suspensión' })
            .eq('id', REAL_ORG_ID);

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/widget/session',
                headers: { origin: TEST_ORIGIN },
                payload: { publicKey },
            });
            expect(response.statusCode).toBe(403);
        } finally {
            await supabaseAdmin
                .from('organizations')
                .update({ status: 'active', suspended_reason: null, suspended_at: null })
                .eq('id', REAL_ORG_ID);
            await app.close();
        }
    });

    it('contraparte de éxito: publicKey y Origin válidos devuelven un token efímero de conversación', async () => {
        mockGetSignedUrl(async () => ({ signedUrl: 'wss://api.elevenlabs.io/v1/convai/conversation?signed=abc' }));

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/widget/session',
                headers: { origin: TEST_ORIGIN },
                payload: { publicKey },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.status).toBe('ok');
            expect(body.signedUrl).toBe('wss://api.elevenlabs.io/v1/convai/conversation?signed=abc');
        } finally {
            await supabaseAdmin.from('usage_events').delete().eq('organization_id', REAL_ORG_ID).eq('unit_type', 'web_widget_session');
            await app.close();
        }
    });

    it('registra el evento de uso en usage_events con metadata.channel = "web" tras una sesión exitosa', async () => {
        mockGetSignedUrl(async () => ({ signedUrl: 'wss://signed-url-test' }));

        const app = await buildTestApp();
        try {
            await app.inject({
                method: 'POST',
                url: '/api/widget/session',
                headers: { origin: TEST_ORIGIN },
                payload: { publicKey },
            });

            const { data } = await supabaseAdmin
                .from('usage_events')
                .select('metadata, unit_type, provider, quantity')
                .eq('organization_id', REAL_ORG_ID)
                .eq('unit_type', 'web_widget_session')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            expect(data?.provider).toBe('elevenlabs');
            expect(data?.quantity).toBe(1);
            expect((data?.metadata as Record<string, unknown> | null)?.channel).toBe('web');
        } finally {
            await supabaseAdmin.from('usage_events').delete().eq('organization_id', REAL_ORG_ID).eq('unit_type', 'web_widget_session');
            await app.close();
        }
    });

    it('degradación: si ElevenLabs falla, responde 200 con status "degraded" en vez de un error', async () => {
        mockGetSignedUrl(async () => {
            throw new Error('Fallo simulado del proveedor');
        });

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/widget/session',
                headers: { origin: TEST_ORIGIN },
                payload: { publicKey },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.status).toBe('degraded');
            expect(body.reason).toBe('provider_error');
        } finally {
            await app.close();
        }
    });

    describe('Cortafuegos de costo', () => {
        it('degradación: al superar el tope diario configurado por organización, responde 200 con formulario de contacto en vez de un error', async () => {
            await supabaseAdmin.from('organizations').update({ widget_daily_session_limit: 1 }).eq('id', REAL_ORG_ID);
            await supabaseAdmin.from('widget_session_attempts').insert({ organization_id: REAL_ORG_ID, source_ip: 'seed-unrelated-ip' });

            const trigger = mockGetSignedUrl(async () => ({ signedUrl: 'wss://no-deberia-llamarse' }));
            const uniqueIp = `10.9.${Date.now() % 200}.1`;

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/widget/session',
                    headers: { origin: TEST_ORIGIN, 'x-forwarded-for': uniqueIp },
                    payload: { publicKey },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.status).toBe('degraded');
                expect(body.reason).toBe('rate_limited');
                expect(trigger).not.toHaveBeenCalled();
            } finally {
                await supabaseAdmin.from('organizations').update({ widget_daily_session_limit: originalDailyLimit ?? 200 }).eq('id', REAL_ORG_ID);
                await app.close();
            }
        });

        it('degradación: al superar el límite por IP/hora, responde 200 con formulario de contacto en vez de un error', async () => {
            const ip = `10.9.${Date.now() % 200}.9`;
            const rows = Array.from({ length: 30 }, () => ({ organization_id: REAL_ORG_ID, source_ip: ip }));
            await supabaseAdmin.from('widget_session_attempts').insert(rows);

            const trigger = mockGetSignedUrl(async () => ({ signedUrl: 'wss://no-deberia-llamarse' }));

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/widget/session',
                    headers: { origin: TEST_ORIGIN, 'x-forwarded-for': ip },
                    payload: { publicKey },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.status).toBe('degraded');
                expect(body.reason).toBe('rate_limited');
                expect(trigger).not.toHaveBeenCalled();
            } finally {
                await supabaseAdmin.from('widget_session_attempts').delete().eq('source_ip', ip);
                await app.close();
            }
        });
    });
});
