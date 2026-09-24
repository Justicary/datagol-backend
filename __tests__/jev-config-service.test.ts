import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
    getJevConfig,
    updateJevConfig,
    validateJevCredentials,
    isJevConfigValidated,
} from '../src/services/jev-config-service.js';
import * as secretService from '../src/services/secret-service.js';
import * as keyClient from '../src/services/jev/openrouter-key-client.js';
import { LlmProviderError, type LlmProviderErrorKind } from '../src/services/llm/llm-provider.interface.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';

interface FakeFastifyOptions {
    updateError?: { message: string } | null;
}

function buildFakeFastify(initialIntegrationSettings: Record<string, unknown> = {}, options: FakeFastifyOptions = {}) {
    let integrationSettings = initialIntegrationSettings;
    const eqCalls: Array<[string, unknown]> = [];
    const selectCalls: string[] = [];
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const fastify = {
        log,
        supabaseAdmin: {
            from: vi.fn((table: string) => {
                if (table !== 'organizations') return {};
                return {
                    select: vi.fn((columns: string) => {
                        selectCalls.push(columns);
                        return {
                        eq: vi.fn((column: string, value: unknown) => {
                            eqCalls.push([column, value]);
                            return {
                            maybeSingle: vi.fn().mockImplementation(() =>
                                Promise.resolve({ data: { integration_settings: integrationSettings }, error: null })
                            ),
                            };
                        }),
                        };
                    }),
                    update: vi.fn((payload: { integration_settings: Record<string, unknown> }) => ({
                        eq: vi.fn((column: string, value: unknown) => {
                            eqCalls.push([column, value]);
                            if (options.updateError) return Promise.resolve({ error: options.updateError });
                            integrationSettings = payload.integration_settings;
                            return Promise.resolve({ error: null });
                        }),
                    })),
                };
            }),
        },
    } as unknown as FastifyInstance;

    return { fastify, log, eqCalls, selectCalls, getIntegrationSettings: () => integrationSettings };
}

describe('services/jev-config-service.ts', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('getJevConfig / updateJevConfig', () => {
        it('getJevConfig devuelve config vacía si nunca se configuró', async () => {
            const { fastify } = buildFakeFastify({});
            expect(await getJevConfig(fastify, 'org-1')).toEqual({ model: null, validatedAt: null, lastError: null });
        });

        it('getJevConfig ignora valores con tipo incorrecto en integration_settings.jev', async () => {
            const { fastify } = buildFakeFastify({ jev: { model: 42, validatedAt: true, lastError: {} } });
            expect(await getJevConfig(fastify, 'org-1')).toEqual({ model: null, validatedAt: null, lastError: null });
        });

        it('updateJevConfig guarda el modelo, resetea la validación previa y NO toca integration_settings.llm', async () => {
            const llm = { provider: 'openrouter', model: 'deepseek/x', baseUrl: 'https://openrouter.ai/api/v1', validatedAt: 'v', lastError: null };
            const { fastify, getIntegrationSettings } = buildFakeFastify({
                llm,
                jev: { model: '~typesafe/jev-old', validatedAt: '2026-09-01T00:00:00.000Z', lastError: null },
            });

            const result = await updateJevConfig(fastify, 'org-1', { model: '~typesafe/jev-latest' });

            expect(result).toEqual({ success: true });
            expect(getIntegrationSettings().jev).toEqual({ model: '~typesafe/jev-latest', validatedAt: null, lastError: null });
            expect(getIntegrationSettings().llm).toEqual(llm);
        });

        it('lee y escribe SOLO la fila de la organización pedida (filtro por id)', async () => {
            const { fastify, eqCalls, selectCalls } = buildFakeFastify({});
            await getJevConfig(fastify, 'org-A');
            await updateJevConfig(fastify, 'org-A', { model: '~typesafe/jev-latest' });
            expect(selectCalls).toEqual(['integration_settings', 'integration_settings']);
            expect(eqCalls).toEqual([
                ['id', 'org-A'],
                ['id', 'org-A'],
                ['id', 'org-A'],
            ]);
        });

        it('updateJevConfig devuelve error accionable si falla la escritura', async () => {
            const { fastify, log } = buildFakeFastify({}, { updateError: { message: 'boom' } });
            const result = await updateJevConfig(fastify, 'org-1', { model: '~typesafe/jev-latest' });
            expect(result).toEqual({ success: false, error: 'No se pudo guardar la configuración de Jev.' });
            expect(log.error).toHaveBeenCalledWith(
                { err: 'boom', organizationId: 'org-1' },
                '[JevConfig] Error guardando configuración de Jev'
            );
        });
    });

    describe('validateJevCredentials', () => {
        it('kind=not_configured cuando no hay modelo guardado (no consulta Vault ni OpenRouter)', async () => {
            const { fastify } = buildFakeFastify({});
            const getSecretSpy = vi.spyOn(secretService, 'getSecret');
            const keySpy = vi.spyOn(keyClient, 'fetchOpenRouterKeyInfo');

            const result = await validateJevCredentials(fastify, 'org-1');

            expect(result).toEqual({
                success: false,
                kind: 'not_configured',
                error: 'No hay un modelo de Jev configurado para esta organización.',
            });
            expect(getSecretSpy).not.toHaveBeenCalled();
            expect(keySpy).not.toHaveBeenCalled();
        });

        it('kind=not_configured cuando no hay llave jev_api_key en Vault, y persiste lastError', async () => {
            const { fastify, getIntegrationSettings } = buildFakeFastify({ jev: { model: '~typesafe/jev-latest' } });
            const getSecretSpy = vi.spyOn(secretService, 'getSecret').mockResolvedValue(null);

            const result = await validateJevCredentials(fastify, 'org-1');

            expect(result).toMatchObject({ success: false, kind: 'not_configured' });
            expect(getSecretSpy).toHaveBeenCalledWith('org-1', SECRET_KEYS.JEV_API_KEY);
            expect((getIntegrationSettings().jev as { lastError: string }).lastError).toMatch(/llave de OpenRouter/);
        });

        it('usa la llave de Jev (nunca la del LLM) y acepta una llave sin tope de gasto (limit_remaining null)', async () => {
            const { fastify } = buildFakeFastify({ jev: { model: '~typesafe/jev-latest' } });
            const getSecretSpy = vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-or-jev');
            vi.spyOn(keyClient, 'fetchOpenRouterKeyInfo').mockResolvedValue({ label: null, limitRemaining: null, isFreeTier: false });

            const result = await validateJevCredentials(fastify, 'org-1');

            expect(result.success).toBe(true);
            expect(getSecretSpy).toHaveBeenCalledTimes(1);
            expect(getSecretSpy).toHaveBeenCalledWith('org-1', SECRET_KEYS.JEV_API_KEY);
            expect(getSecretSpy).not.toHaveBeenCalledWith('org-1', SECRET_KEYS.LLM_API_KEY);
        });

        it('éxito: guarda validatedAt, limpia lastError previo y la config queda validada', async () => {
            const { fastify, log, getIntegrationSettings } = buildFakeFastify({
                jev: { model: '~typesafe/jev-latest', validatedAt: null, lastError: 'error anterior' },
            });
            vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-or-jev');
            const keySpy = vi
                .spyOn(keyClient, 'fetchOpenRouterKeyInfo')
                .mockResolvedValue({ label: 'org', limitRemaining: 5, isFreeTier: false });

            const result = await validateJevCredentials(fastify, 'org-1');

            expect(keySpy).toHaveBeenCalledWith('sk-or-jev');
            expect(result.success).toBe(true);
            expect(result.validatedAt).toBeDefined();
            expect(getIntegrationSettings().jev).toEqual({
                model: '~typesafe/jev-latest',
                validatedAt: result.validatedAt,
                lastError: null,
            });
            expect(await isJevConfigValidated(fastify, 'org-1')).toBe(true);
            expect(log.info).toHaveBeenCalledWith(
                { organizationId: 'org-1' },
                '[JevConfig] Validación de la llave de OpenRouter para Jev exitosa'
            );
        });

        it('llave con tope de gasto agotado (limit_remaining <= 0) → no_credit aunque OpenRouter responda 200', async () => {
            const { fastify } = buildFakeFastify({ jev: { model: '~typesafe/jev-latest' } });
            vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-or-jev');
            vi.spyOn(keyClient, 'fetchOpenRouterKeyInfo').mockResolvedValue({ label: null, limitRemaining: 0, isFreeTier: false });

            const result = await validateJevCredentials(fastify, 'org-1');

            expect(result).toMatchObject({ success: false, kind: 'no_credit' });
            expect(await isJevConfigValidated(fastify, 'org-1')).toBe(false);
        });

        const errorCases: LlmProviderErrorKind[] = ['invalid_key', 'no_credit', 'network_error', 'unknown'];
        it.each(errorCases)('fallo %s: mensaje accionable, sin el mensaje crudo, y conserva el validatedAt anterior', async (kind) => {
            const previousValidatedAt = '2026-09-01T00:00:00.000Z';
            const { fastify, log, getIntegrationSettings } = buildFakeFastify({
                jev: { model: '~typesafe/jev-latest', validatedAt: previousValidatedAt, lastError: null },
            });
            vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-or-jev');
            vi.spyOn(keyClient, 'fetchOpenRouterKeyInfo').mockRejectedValue(new LlmProviderError(kind, 'mensaje crudo del proveedor'));

            const result = await validateJevCredentials(fastify, 'org-1');

            expect(result.success).toBe(false);
            expect(result.kind).toBe(kind);
            expect(result.error).not.toContain('mensaje crudo');
            const jev = getIntegrationSettings().jev as { validatedAt: string; lastError: string };
            expect(jev.validatedAt).toBe(previousValidatedAt);
            expect(jev.lastError).toBe(result.error);
            expect(await isJevConfigValidated(fastify, 'org-1')).toBe(false);
            // El mensaje crudo solo va al log interno, con el contexto del tenant.
            expect(log.warn).toHaveBeenCalledWith(
                { organizationId: 'org-1', kind, providerMessage: 'mensaje crudo del proveedor' },
                '[JevConfig] Validación de la llave de OpenRouter para Jev falló'
            );
        });

        it('un error que no es LlmProviderError se clasifica como unknown', async () => {
            const { fastify } = buildFakeFastify({ jev: { model: '~typesafe/jev-latest' } });
            vi.spyOn(secretService, 'getSecret').mockResolvedValue('sk-or-jev');
            vi.spyOn(keyClient, 'fetchOpenRouterKeyInfo').mockRejectedValue(new Error('inesperado'));

            const result = await validateJevCredentials(fastify, 'org-1');

            expect(result).toMatchObject({ success: false, kind: 'unknown' });
        });
    });

    describe('isJevConfigValidated', () => {
        it('false cuando no hay modelo configurado', async () => {
            const { fastify } = buildFakeFastify({ jev: { validatedAt: '2026-09-01T00:00:00.000Z', lastError: null } });
            expect(await isJevConfigValidated(fastify, 'org-1')).toBe(false);
        });

        it('false cuando nunca se validó', async () => {
            const { fastify } = buildFakeFastify({ jev: { model: '~typesafe/jev-latest', validatedAt: null, lastError: null } });
            expect(await isJevConfigValidated(fastify, 'org-1')).toBe(false);
        });

        it('false cuando la validación más reciente falló aunque exista validatedAt viejo', async () => {
            const { fastify } = buildFakeFastify({
                jev: { model: '~typesafe/jev-latest', validatedAt: '2026-09-01T00:00:00.000Z', lastError: 'falló' },
            });
            expect(await isJevConfigValidated(fastify, 'org-1')).toBe(false);
        });

        it('contraparte de éxito: true con modelo, validatedAt y sin lastError', async () => {
            const { fastify } = buildFakeFastify({
                jev: { model: '~typesafe/jev-latest', validatedAt: '2026-09-01T00:00:00.000Z', lastError: null },
            });
            expect(await isJevConfigValidated(fastify, 'org-1')).toBe(true);
        });
    });
});
