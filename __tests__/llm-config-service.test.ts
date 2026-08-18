import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    getLlmConfig,
    updateLlmConfig,
    validateLlmCredentials,
    isLlmConfigValidated,
} from '../src/services/llm-config-service.js';
import * as secretService from '../src/services/secret-service.js';
import * as rateService from '../src/services/rate-service.js';
import { LlmProviderFactory } from '../src/services/llm/LlmProviderFactory.js';
import { LlmProviderError, type LlmProviderErrorKind } from '../src/services/llm/llm-provider.interface.js';

function buildFakeFastify(initialIntegrationSettings: Record<string, unknown> = {}) {
    let integrationSettings = initialIntegrationSettings;
    const usageInserts: Record<string, unknown>[] = [];

    const fastify: any = {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        supabaseAdmin: {
            from: vi.fn((table: string) => {
                if (table === 'organizations') {
                    return {
                        select: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                maybeSingle: vi.fn().mockImplementation(() =>
                                    Promise.resolve({ data: { integration_settings: integrationSettings }, error: null })
                                ),
                            }),
                        }),
                        update: vi.fn((payload: any) => ({
                            eq: vi.fn().mockImplementation(() => {
                                integrationSettings = payload.integration_settings ?? integrationSettings;
                                return Promise.resolve({ error: null });
                            }),
                        })),
                    };
                }
                if (table === 'usage_events') {
                    return {
                        insert: vi.fn().mockImplementation((rows: any) => {
                            usageInserts.push(...(Array.isArray(rows) ? rows : [rows]));
                            return Promise.resolve({ error: null });
                        }),
                    };
                }
                return {};
            }),
        },
    };

    return { fastify, usageInserts, getIntegrationSettings: () => integrationSettings };
}

describe('services/llm-config-service.ts', () => {
    beforeEach(() => {
        vi.spyOn(rateService, 'getRate').mockResolvedValue({ unitRateUsd: 0 } as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('getLlmConfig / updateLlmConfig', () => {
        it('getLlmConfig devuelve config vacía si nunca se configuró', async () => {
            const { fastify } = buildFakeFastify({});
            const config = await getLlmConfig(fastify, 'org-1');
            expect(config).toEqual({ provider: null, model: null, baseUrl: null, validatedAt: null, lastError: null });
        });

        it('updateLlmConfig guarda provider/model y resetea validatedAt/lastError previos', async () => {
            const { fastify, getIntegrationSettings } = buildFakeFastify({
                theme: { primary: '#000' },
                llm: { provider: 'openai', model: 'old-model', baseUrl: null, validatedAt: '2026-01-01T00:00:00Z', lastError: null },
            });

            const result = await updateLlmConfig(fastify, 'org-1', { provider: 'anthropic', model: 'claude-sonnet' });

            expect(result.success).toBe(true);
            const settings = getIntegrationSettings() as any;
            expect(settings.theme).toEqual({ primary: '#000' }); // merge, no reemplazo completo
            expect(settings.llm).toEqual({ provider: 'anthropic', model: 'claude-sonnet', baseUrl: null, validatedAt: null, lastError: null });
        });

        it('updateLlmConfig con openrouter conserva baseUrl', async () => {
            const { fastify, getIntegrationSettings } = buildFakeFastify({});
            await updateLlmConfig(fastify, 'org-1', {
                provider: 'openrouter',
                model: 'deepseek/deepseek-v4-flash-0731',
                baseUrl: 'https://openrouter.ai/api/v1',
            });
            const settings = getIntegrationSettings() as any;
            expect(settings.llm.baseUrl).toBe('https://openrouter.ai/api/v1');
        });
    });

    describe('validateLlmCredentials', () => {
        it('kind=not_configured cuando no hay provider/model guardado', async () => {
            const { fastify } = buildFakeFastify({});
            const result = await validateLlmCredentials(fastify, 'org-1');
            expect(result).toMatchObject({ success: false, kind: 'not_configured' });
        });

        it('kind=not_configured cuando no hay llave guardada en Vault', async () => {
            const { fastify } = buildFakeFastify({ llm: { provider: 'openai', model: 'gpt-4o-mini' } });
            vi.spyOn(secretService, 'getSecret').mockResolvedValue(null);

            const result = await validateLlmCredentials(fastify, 'org-1');
            expect(result).toMatchObject({ success: false, kind: 'not_configured' });
        });

        it('éxito: guarda validatedAt y registra usage_events con tarifa 0', async () => {
            const { fastify, usageInserts, getIntegrationSettings } = buildFakeFastify({
                llm: { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731', baseUrl: 'https://openrouter.ai/api/v1' },
            });
            vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-or-real');
            vi.spyOn(LlmProviderFactory, 'getProvider').mockReturnValue({
                complete: vi.fn().mockResolvedValue({ text: 'pong', inputTokens: 3, outputTokens: 1 }),
            });

            const result = await validateLlmCredentials(fastify, 'org-1');

            expect(result.success).toBe(true);
            expect(result.validatedAt).toBeDefined();

            const settings = getIntegrationSettings() as any;
            expect(settings.llm.validatedAt).toBe(result.validatedAt);
            expect(settings.llm.lastError).toBeNull();

            expect(usageInserts).toHaveLength(2);
            expect(usageInserts).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ provider: 'llm', unit_type: 'llm_input_token', quantity: 3, unit_rate_usd: 0 }),
                    expect.objectContaining({ provider: 'llm', unit_type: 'llm_output_token', quantity: 1, unit_rate_usd: 0 }),
                ])
            );
        });

        const cases: Array<{ kind: LlmProviderErrorKind }> = [
            { kind: 'invalid_key' },
            { kind: 'no_credit' },
            { kind: 'model_not_found' },
            { kind: 'network_error' },
            { kind: 'unknown' },
        ];

        it.each(cases)('kind=$kind: guarda lastError accionable y nunca expone el mensaje crudo del proveedor', async ({ kind }) => {
            const rawProviderMessage = 'RAW_PROVIDER_INTERNAL_MESSAGE_never_exposed';
            const { fastify, usageInserts, getIntegrationSettings } = buildFakeFastify({
                llm: { provider: 'anthropic', model: 'claude-sonnet' },
            });
            vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-ant');
            vi.spyOn(LlmProviderFactory, 'getProvider').mockReturnValue({
                complete: vi.fn().mockRejectedValue(new LlmProviderError(kind, rawProviderMessage)),
            });

            const result = await validateLlmCredentials(fastify, 'org-1');

            expect(result).toMatchObject({ success: false, kind });
            expect(result.error).not.toContain(rawProviderMessage);

            const settings = getIntegrationSettings() as any;
            expect(settings.llm.lastError).toBe(result.error);
            expect(settings.llm.lastError).not.toContain(rawProviderMessage);
            expect(usageInserts).toHaveLength(0);
        });
    });

    describe('isLlmConfigValidated — guarda de B.5 (docs/tasks/reportes-semanales.md)', () => {
        it('false cuando no hay provider/model configurado', async () => {
            const { fastify } = buildFakeFastify({});
            expect(await isLlmConfigValidated(fastify, 'org-1')).toBe(false);
        });

        it('false cuando hay config pero nunca se validó (validatedAt nulo)', async () => {
            const { fastify } = buildFakeFastify({ llm: { provider: 'openai', model: 'gpt-4o-mini', validatedAt: null, lastError: null } });
            expect(await isLlmConfigValidated(fastify, 'org-1')).toBe(false);
        });

        it('false cuando la validación más reciente falló (lastError no nulo, aunque validatedAt sea viejo)', async () => {
            const { fastify } = buildFakeFastify({
                llm: { provider: 'openai', model: 'gpt-4o-mini', validatedAt: '2026-01-01T00:00:00.000Z', lastError: 'La llave no es válida.' },
            });
            expect(await isLlmConfigValidated(fastify, 'org-1')).toBe(false);
        });

        it('contraparte de éxito: true cuando hay provider/model, validatedAt no nulo y lastError nulo', async () => {
            const { fastify } = buildFakeFastify({
                llm: { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731', validatedAt: '2026-08-01T00:00:00.000Z', lastError: null },
            });
            expect(await isLlmConfigValidated(fastify, 'org-1')).toBe(true);
        });
    });
});
