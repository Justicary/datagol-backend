import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getRate, invalidateRateCache } from '../src/services/rate-service.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

const fakeFastify = { supabaseAdmin } as unknown as FastifyInstance;

describe('3.1 — getRate: resolución histórica de tarifas contra provider_rates real', () => {
    beforeEach(() => {
        invalidateRateCache();
        vi.restoreAllMocks();
    });

    it('resuelve la tarifa de elevenlabs/agent_minute vigente en una fecha dentro de su rango', async () => {
        const rate = await getRate(fakeFastify, 'elevenlabs', 'agent_minute', new Date('2026-06-01T00:00:00Z'));
        expect(rate).not.toBeNull();
        expect(rate?.unitRateUsd).toBeCloseTo(0.08, 5);
        expect(rate?.provider).toBe('elevenlabs');
        expect(rate?.unitType).toBe('agent_minute');
    });

    it('nunca usa la tarifa actual para un consumo pasado: una fecha anterior a effective_from no encuentra tarifa', async () => {
        const rate = await getRate(fakeFastify, 'elevenlabs', 'agent_minute', new Date('2020-01-01T00:00:00Z'));
        expect(rate).toBeNull();
    });

    it('resuelve telnyx/sip_inbound_local_mx vigente en su rango', async () => {
        const rate = await getRate(fakeFastify, 'telnyx', 'sip_inbound_local_mx', new Date('2026-08-15T00:00:00Z'));
        expect(rate).not.toBeNull();
        expect(rate?.unitRateUsd).toBeCloseTo(0.005, 5);
    });

    it('devuelve null (nunca inventa una tarifa) para un provider/unit_type sin fila en provider_rates', async () => {
        const rate = await getRate(fakeFastify, 'llm', 'token', new Date());
        expect(rate).toBeNull();
    });

    it('la caché en memoria evita una segunda consulta: invalidateRateCache fuerza una recarga', async () => {
        const first = await getRate(fakeFastify, 'elevenlabs', 'agent_minute', new Date('2026-06-01T00:00:00Z'));
        expect(first).not.toBeNull();

        const second = await getRate(fakeFastify, 'elevenlabs', 'agent_minute', new Date('2026-06-01T00:00:00Z'));
        expect(second?.unitRateUsd).toBe(first?.unitRateUsd);

        invalidateRateCache();
        const third = await getRate(fakeFastify, 'elevenlabs', 'agent_minute', new Date('2026-06-01T00:00:00Z'));
        expect(third?.unitRateUsd).toBe(first?.unitRateUsd);
    });

    function buildCountingFastify(rows: Array<Record<string, unknown>>) {
        const selectSpy = vi.fn().mockResolvedValue({ data: rows, error: null });
        const fromSpy = vi.fn().mockReturnValue({ select: selectSpy });
        const fastify = { supabaseAdmin: { from: fromSpy } } as unknown as FastifyInstance;
        return { fastify, fromSpy, selectSpy };
    }

    it('la caché realmente evita la segunda consulta a provider_rates (no solo coincide el valor por casualidad)', async () => {
        const { fastify, fromSpy } = buildCountingFastify([
            {
                id: 'rate-cache-1',
                provider: 'cache_test_provider',
                unit_type: 'cache_test_unit',
                unit_rate_usd: '0.20',
                effective_from: '2020-01-01T00:00:00Z',
                effective_to: null,
            },
        ]);

        await getRate(fastify, 'cache_test_provider', 'cache_test_unit', new Date());
        await getRate(fastify, 'cache_test_provider', 'cache_test_unit', new Date());

        expect(fromSpy).toHaveBeenCalledTimes(1);
    });

    it('la caché expira tras el TTL de 5 minutos y fuerza una relectura real', async () => {
        const { fastify, fromSpy } = buildCountingFastify([
            {
                id: 'rate-ttl-1',
                provider: 'ttl_test_provider',
                unit_type: 'ttl_test_unit',
                unit_rate_usd: '0.20',
                effective_from: '2020-01-01T00:00:00Z',
                effective_to: null,
            },
        ]);

        const dateSpy = vi.spyOn(Date, 'now');
        const T0 = 1_700_000_000_000;

        dateSpy.mockReturnValueOnce(T0);
        await getRate(fastify, 'ttl_test_provider', 'ttl_test_unit', new Date());

        // Justo después del TTL de 5 minutos (300_000ms).
        dateSpy.mockReturnValueOnce(T0 + 300_001);
        await getRate(fastify, 'ttl_test_provider', 'ttl_test_unit', new Date());

        expect(fromSpy).toHaveBeenCalledTimes(2);
        dateSpy.mockRestore();
    });

    it('el límite del TTL es estrictamente "<": exactamente a los 300000ms ya se considera expirado (no "<=")', async () => {
        const { fastify, fromSpy } = buildCountingFastify([
            {
                id: 'rate-ttl-boundary-1',
                provider: 'ttl_boundary_provider',
                unit_type: 'ttl_boundary_unit',
                unit_rate_usd: '0.20',
                effective_from: '2020-01-01T00:00:00Z',
                effective_to: null,
            },
        ]);

        const dateSpy = vi.spyOn(Date, 'now');
        const T0 = 1_700_000_000_000;

        dateSpy.mockReturnValueOnce(T0);
        await getRate(fastify, 'ttl_boundary_provider', 'ttl_boundary_unit', new Date());

        // Exactamente el TTL: now - cachedAt === CACHE_TTL_MS, no < CACHE_TTL_MS.
        dateSpy.mockReturnValueOnce(T0 + 300_000);
        await getRate(fastify, 'ttl_boundary_provider', 'ttl_boundary_unit', new Date());

        expect(fromSpy).toHaveBeenCalledTimes(2);
        dateSpy.mockRestore();
    });

    it('solicita exactamente las columnas esperadas de provider_rates', async () => {
        const { fastify, selectSpy } = buildCountingFastify([]);
        await getRate(fastify, 'cualquier_provider', 'cualquier_unit', new Date());
        expect(selectSpy).toHaveBeenCalledWith('id, provider, unit_type, unit_rate_usd, effective_from, effective_to');
    });

    it('data null (sin error) resulta en un tarifario vacío, no en una excepción', async () => {
        const fastify = {
            supabaseAdmin: {
                from: () => ({
                    select: () => Promise.resolve({ data: null, error: null }),
                }),
            },
        } as unknown as FastifyInstance;

        const rate = await getRate(fastify, 'cualquier_provider', 'cualquier_unit', new Date());
        expect(rate).toBeNull();
    });

    it('filtra por provider Y unitType exactos: no basta con que coincida solo uno de los dos', async () => {
        const mockFastify = {
            supabaseAdmin: {
                from: () => ({
                    select: () =>
                        Promise.resolve({
                            data: [
                                {
                                    id: 'wrong-unit-same-provider',
                                    provider: 'multi_test_provider',
                                    unit_type: 'unit_que_no_es',
                                    unit_rate_usd: '9.99',
                                    effective_from: '2020-01-01T00:00:00Z',
                                    effective_to: null,
                                },
                                {
                                    id: 'wrong-provider-same-unit',
                                    provider: 'provider_que_no_es',
                                    unit_type: 'multi_test_unit',
                                    unit_rate_usd: '9.99',
                                    effective_from: '2020-01-01T00:00:00Z',
                                    effective_to: null,
                                },
                                {
                                    id: 'correct-match',
                                    provider: 'multi_test_provider',
                                    unit_type: 'multi_test_unit',
                                    unit_rate_usd: '0.42',
                                    effective_from: '2020-01-01T00:00:00Z',
                                    effective_to: null,
                                },
                            ],
                            error: null,
                        }),
                }),
            },
        } as unknown as FastifyInstance;

        const rate = await getRate(mockFastify, 'multi_test_provider', 'multi_test_unit', new Date());
        expect(rate?.id).toBe('correct-match');
        expect(rate?.unitRateUsd).toBe(0.42);
    });

    it('una tarifa vencida sin sucesora vigente no se usa (nunca inventa/reutiliza una tarifa expirada)', async () => {
        const mockFastify = {
            supabaseAdmin: {
                from: () => ({
                    select: () =>
                        Promise.resolve({
                            data: [
                                {
                                    id: 'expired-no-successor',
                                    provider: 'expired_test_provider',
                                    unit_type: 'expired_test_unit',
                                    unit_rate_usd: '0.42',
                                    effective_from: '2020-01-01T00:00:00Z',
                                    effective_to: '2021-01-01T00:00:00Z',
                                },
                            ],
                            error: null,
                        }),
                }),
            },
        } as unknown as FastifyInstance;

        // occurredAt muy posterior al effective_to: sin la tarifa expirada
        // no queda ningún candidato válido.
        const rate = await getRate(mockFastify, 'expired_test_provider', 'expired_test_unit', new Date('2026-01-01T00:00:00Z'));
        expect(rate).toBeNull();
    });

    it('el límite de effectiveTo es estrictamente ">": un occurredAt exactamente igual a effective_to ya no aplica (no ">=")', async () => {
        const mockFastify = {
            supabaseAdmin: {
                from: () => ({
                    select: () =>
                        Promise.resolve({
                            data: [
                                {
                                    id: 'expired-exact-boundary',
                                    provider: 'boundary_test_provider',
                                    unit_type: 'boundary_test_unit',
                                    unit_rate_usd: '0.42',
                                    effective_from: '2020-01-01T00:00:00Z',
                                    effective_to: '2021-01-01T00:00:00Z',
                                },
                            ],
                            error: null,
                        }),
                }),
            },
        } as unknown as FastifyInstance;

        // occurredAt EXACTAMENTE igual a effective_to: sin otra tarifa que la
        // cubra, debe tratarse como ya vencida (effectiveTo > occurredAt es
        // estricto, no effectiveTo >= occurredAt).
        const rate = await getRate(
            mockFastify,
            'boundary_test_provider',
            'boundary_test_unit',
            new Date('2021-01-01T00:00:00Z')
        );
        expect(rate).toBeNull();
    });

    it('ordena correctamente entre 3+ candidatos VIGENTES simultáneamente (el orden real importa, no gana por ser el único que pasa el filtro)', async () => {
        // Los tres quedan abiertos (effective_to: null) y con effective_from
        // <= occurredAt: los TRES pasan el filtro al mismo tiempo, así que
        // solo el sort por effectiveFrom desc decide cuál gana. Se insertan
        // en orden ascendente (el peor caso para un "candidates;" sin sort,
        // que dejaría "oldest" en la posición 0).
        const mockFastify = {
            supabaseAdmin: {
                from: () => ({
                    select: () =>
                        Promise.resolve({
                            data: [
                                {
                                    id: 'oldest',
                                    provider: 'sort_test_provider',
                                    unit_type: 'sort_test_unit',
                                    unit_rate_usd: '0.10',
                                    effective_from: '2020-01-01T00:00:00Z',
                                    effective_to: null,
                                },
                                {
                                    id: 'middle',
                                    provider: 'sort_test_provider',
                                    unit_type: 'sort_test_unit',
                                    unit_rate_usd: '0.20',
                                    effective_from: '2022-01-01T00:00:00Z',
                                    effective_to: null,
                                },
                                {
                                    id: 'newest',
                                    provider: 'sort_test_provider',
                                    unit_type: 'sort_test_unit',
                                    unit_rate_usd: '0.30',
                                    effective_from: '2024-01-01T00:00:00Z',
                                    effective_to: null,
                                },
                            ],
                            error: null,
                        }),
                }),
            },
        } as unknown as FastifyInstance;

        const rate = await getRate(mockFastify, 'sort_test_provider', 'sort_test_unit', new Date('2026-08-01T00:00:00Z'));
        expect(rate?.id).toBe('newest');
        expect(rate?.unitRateUsd).toBe(0.3);
    });

    it('ordena múltiples candidatos por effectiveFrom más reciente y respeta effectiveTo exclusivo', async () => {
        const mockFastify = {
            supabaseAdmin: {
                from: () => ({
                    select: () => Promise.resolve({
                        data: [
                            {
                                id: 'rate-1',
                                provider: 'test_provider',
                                unit_type: 'test_unit',
                                unit_rate_usd: '0.10',
                                effective_from: '2026-01-01T00:00:00Z',
                                effective_to: '2026-06-01T00:00:00Z',
                            },
                            {
                                id: 'rate-2',
                                provider: 'test_provider',
                                unit_type: 'test_unit',
                                unit_rate_usd: '0.15',
                                effective_from: '2026-06-01T00:00:00Z',
                                effective_to: null,
                            },
                        ],
                        error: null,
                    }),
                }),
            },
        } as unknown as FastifyInstance;

        // Exactamente en la fecha límite effectiveFrom de rate-2 (2026-06-01): debe seleccionar rate-2 por ordenamiento más reciente
        const rateNew = await getRate(mockFastify, 'test_provider', 'test_unit', new Date('2026-06-01T00:00:00Z'));
        expect(rateNew?.id).toBe('rate-2');
        expect(rateNew?.unitRateUsd).toBe(0.15);

        // Fecha intermedia para rate-1 (2026-03-01): debe resolver rate-1
        invalidateRateCache();
        const rateOld = await getRate(mockFastify, 'test_provider', 'test_unit', new Date('2026-03-01T00:00:00Z'));
        expect(rateOld?.id).toBe('rate-1');
        expect(rateOld?.unitRateUsd).toBe(0.10);

        // Fecha exactamente igual a effective_to de rate-1 (2026-06-01): rate-1 no aplica porque effectiveTo > occurredAt es estricto
        invalidateRateCache();
        const rateExpiredCheck = await getRate(mockFastify, 'test_provider', 'test_unit', new Date('2026-06-01T00:00:00Z'));
        expect(rateExpiredCheck?.id).not.toBe('rate-1');
    });

    it('lanza excepción explícita cuando la consulta a provider_rates devuelve un error', async () => {
        const errorFastify = {
            supabaseAdmin: {
                from: () => ({
                    select: () => Promise.resolve({
                        data: null,
                        error: { message: 'Database query timeout' },
                    }),
                }),
            },
        } as unknown as FastifyInstance;

        await expect(getRate(errorFastify, 'elevenlabs', 'agent_minute', new Date())).rejects.toThrow(
            'No se pudo cargar el tarifario de provider_rates: Database query timeout'
        );
    });
});
