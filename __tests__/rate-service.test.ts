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
