import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';

vi.mock('../src/services/email.js', () => ({
    sendElevenLabsCreditsAlertEmail: vi.fn(),
}));

import { sendElevenLabsCreditsAlertEmail } from '../src/services/email.js';
import {
    checkElevenLabsCreditsHandler,
    checkElevenLabsCreditsSweepHandler,
    computeRemainingPercentage,
    type CheckElevenLabsCreditsJobData,
} from '../src/jobs/check-elevenlabs-credits.js';

/**
 * Mismo criterio que __tests__/geocoding.test.ts: Vault real para el
 * secreto (elevenlabs_api_key), pero la red saliente a api.elevenlabs.io se
 * mockea — es un proveedor de pago de terceros.
 */
const realFetch = global.fetch;

function mockElevenLabsSubscription(response: Response) {
    return vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('https://api.elevenlabs.io/')) {
            return response;
        }
        return realFetch(input as any, init);
    });
}

function subscriptionResponse(characterCount: number, characterLimit: number, resetUnix: number): Response {
    return new Response(
        JSON.stringify({
            character_count: characterCount,
            character_limit: characterLimit,
            next_character_count_reset_unix: resetUnix,
        }),
        { status: 200 }
    );
}

function buildFakeFastify(overrides: Record<string, unknown> = {}): FastifyInstance {
    return {
        supabaseAdmin,
        log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        ...overrides,
    } as unknown as FastifyInstance;
}

function buildJob(organizationId: string): Job<CheckElevenLabsCreditsJobData> {
    return { id: 'fake-job-id', data: { organizationId } } as unknown as Job<CheckElevenLabsCreditsJobData>;
}

const CYCLE_1_RESET_UNIX = 1_800_000_000; // ciclo de prueba fijo #1
const CYCLE_2_RESET_UNIX = 1_800_600_000; // ciclo de prueba fijo #2 (distinto)

describe('src/jobs/check-elevenlabs-credits.ts', () => {
    let testOrgId: string;
    const API_KEY_VALUE = 'sk_test_fake_elevenlabs_key_abc123';

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org Pruebas créditos ElevenLabs', email: `test-el-credits-${Date.now()}@example.invalid` })
            .select('id')
            .single();
        if (error || !data) throw new Error(`No se pudo crear la organización dedicada: ${error?.message}`);
        testOrgId = data.id;
    });

    afterAll(async () => {
        await supabaseAdmin.from('organization_usage_alerts').delete().eq('organization_id', testOrgId);
        await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', testOrgId);
        await supabaseAdmin.from('organizations').delete().eq('id', testOrgId);
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.mocked(sendElevenLabsCreditsAlertEmail).mockReset();
    });

    describe('computeRemainingPercentage', () => {
        it('calcula el porcentaje restante redondeado', () => {
            expect(computeRemainingPercentage(85_000, 100_000)).toBe(15);
            expect(computeRemainingPercentage(0, 100_000)).toBe(100);
            expect(computeRemainingPercentage(100_000, 100_000)).toBe(0);
        });
    });

    describe('checkElevenLabsCreditsHandler', () => {
        it('sin credencial de ElevenLabs configurada: se omite sin llamar a la red', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch');
            await checkElevenLabsCreditsHandler(buildFakeFastify(), buildJob(testOrgId));
            expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining('api.elevenlabs.io'), expect.anything());
            expect(sendElevenLabsCreditsAlertEmail).not.toHaveBeenCalled();
            fetchSpy.mockRestore();
        });

        it('contraparte de éxito: con credencial configurada y créditos por encima de todos los umbrales, no envía alerta', async () => {
            const saved = await setSecret(testOrgId, SECRET_KEYS.ELEVENLABS_API_KEY, API_KEY_VALUE);
            expect(saved).toBe(true);

            const mock = mockElevenLabsSubscription(subscriptionResponse(20_000, 100_000, CYCLE_1_RESET_UNIX));

            await checkElevenLabsCreditsHandler(buildFakeFastify(), buildJob(testOrgId));

            expect(sendElevenLabsCreditsAlertEmail).not.toHaveBeenCalled();
            mock.mockRestore();
        });

        it('cruza el umbral 15% pero no 10% ni 5%: inserta un único registro y envía un único correo', async () => {
            vi.mocked(sendElevenLabsCreditsAlertEmail).mockResolvedValue({ data: { id: 'fake-email-id' } } as any);
            const mock = mockElevenLabsSubscription(subscriptionResponse(88_000, 100_000, CYCLE_1_RESET_UNIX));

            await checkElevenLabsCreditsHandler(buildFakeFastify(), buildJob(testOrgId));

            expect(sendElevenLabsCreditsAlertEmail).toHaveBeenCalledTimes(1);
            expect(vi.mocked(sendElevenLabsCreditsAlertEmail).mock.calls[0][0]).toMatchObject({
                threshold: 15,
                remainingPercentage: 12,
            });

            const { data: alerts } = await supabaseAdmin
                .from('organization_usage_alerts')
                .select('alert_type')
                .eq('organization_id', testOrgId);
            expect(alerts?.map((a) => a.alert_type)).toEqual(['elevenlabs_credits_15']);

            mock.mockRestore();
        });

        it('idempotencia: mismo ciclo y mismo umbral cruzado no reenvía el correo', async () => {
            const mock = mockElevenLabsSubscription(subscriptionResponse(89_000, 100_000, CYCLE_1_RESET_UNIX));

            await checkElevenLabsCreditsHandler(buildFakeFastify(), buildJob(testOrgId));

            expect(sendElevenLabsCreditsAlertEmail).not.toHaveBeenCalled();
            mock.mockRestore();
        });

        it('cruza los tres umbrales de una vez: inserta tres registros y envía tres correos', async () => {
            vi.mocked(sendElevenLabsCreditsAlertEmail).mockResolvedValue({ data: { id: 'fake-email-id' } } as any);
            const mock = mockElevenLabsSubscription(subscriptionResponse(97_000, 100_000, CYCLE_2_RESET_UNIX));

            await checkElevenLabsCreditsHandler(buildFakeFastify(), buildJob(testOrgId));

            expect(sendElevenLabsCreditsAlertEmail).toHaveBeenCalledTimes(3);
            const thresholdsSent = vi.mocked(sendElevenLabsCreditsAlertEmail).mock.calls.map((call) => call[0].threshold).sort((a, b) => a - b);
            expect(thresholdsSent).toEqual([5, 10, 15]);

            const { data: alerts } = await supabaseAdmin
                .from('organization_usage_alerts')
                .select('alert_type, cycle_reset_at')
                .eq('organization_id', testOrgId)
                .eq('cycle_reset_at', new Date(CYCLE_2_RESET_UNIX * 1000).toISOString());
            expect(alerts?.length).toBe(3);

            mock.mockRestore();
        });

        it('sin character_limit (plan sin tope): se omite sin lanzar ni enviar correo', async () => {
            const mock = mockElevenLabsSubscription(subscriptionResponse(50_000, 0, CYCLE_1_RESET_UNIX));

            await checkElevenLabsCreditsHandler(buildFakeFastify(), buildJob(testOrgId));

            expect(sendElevenLabsCreditsAlertEmail).not.toHaveBeenCalled();
            mock.mockRestore();
        });

        it('un error HTTP del proveedor propaga el error (para que pg-boss reintente)', async () => {
            const mock = mockElevenLabsSubscription(new Response('Forbidden', { status: 403 }));

            await expect(checkElevenLabsCreditsHandler(buildFakeFastify(), buildJob(testOrgId))).rejects.toThrow();
            expect(sendElevenLabsCreditsAlertEmail).not.toHaveBeenCalled();

            mock.mockRestore();
        });
    });

    describe('checkElevenLabsCreditsSweepHandler', () => {
        it('encola un chequeo individual por cada organización con credencial de ElevenLabs', async () => {
            const send = vi.fn().mockResolvedValue('fake-queue-job-id');
            const fastify = buildFakeFastify({ pgBoss: { send } });

            await checkElevenLabsCreditsSweepHandler(fastify);

            expect(send).toHaveBeenCalledWith('check-elevenlabs-credits', { organizationId: testOrgId });
        });
    });
});
