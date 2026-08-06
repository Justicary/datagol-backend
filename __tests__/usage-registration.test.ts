import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolveCallUsageEntries } from '../src/services/usage-registration.js';
import { invalidateRateCache } from '../src/services/rate-service.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

function buildFakeFastify() {
    return {
        supabaseAdmin,
        log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as unknown as FastifyInstance;
}

const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

describe('3.2 — resolveCallUsageEntries', () => {
    beforeEach(() => {
        invalidateRateCache();
    });

    it('registra únicamente agent_minute cuando no hubo tramo de telefonía (widget web)', async () => {
        const fastify = buildFakeFastify();
        const entries = await resolveCallUsageEntries(fastify, {
            organizationId: REAL_ORG_ID,
            conversationId: 'conv-usage-widget-1',
            durationSeconds: 120,
            occurredAt: new Date('2026-06-01T00:00:00Z'),
            hasPhoneCallLeg: false,
        });

        expect(entries).toHaveLength(1);
        expect(entries[0].provider).toBe('elevenlabs');
        expect(entries[0].unit_type).toBe('agent_minute');
        expect(entries[0].quantity).toBeCloseTo(2, 5); // 120s = 2 minutos
        expect(fastify.log.warn).not.toHaveBeenCalled();
    });

    it('agrega también sip_inbound_local_mx cuando sí hubo tramo de telefonía (contraparte de éxito)', async () => {
        const fastify = buildFakeFastify();
        const entries = await resolveCallUsageEntries(fastify, {
            organizationId: REAL_ORG_ID,
            conversationId: 'conv-usage-phone-1',
            durationSeconds: 200,
            occurredAt: new Date('2026-08-15T00:00:00Z'),
            hasPhoneCallLeg: true,
        });

        expect(entries).toHaveLength(2);
        const byUnitType = Object.fromEntries(entries.map((e) => [e.unit_type, e]));
        expect(byUnitType.agent_minute.provider).toBe('elevenlabs');
        expect(byUnitType.sip_inbound_local_mx.provider).toBe('telnyx');
        expect(byUnitType.sip_inbound_local_mx.quantity).toBeCloseTo(200 / 60, 5);
    });

    it('cada asiento trae una idempotency_key determinística por conversationId+provider+unit_type', async () => {
        const fastify = buildFakeFastify();
        const entries = await resolveCallUsageEntries(fastify, {
            organizationId: REAL_ORG_ID,
            conversationId: 'conv-usage-key-1',
            durationSeconds: 60,
            occurredAt: new Date('2026-06-01T00:00:00Z'),
            hasPhoneCallLeg: false,
        });

        expect(entries[0].idempotency_key).toBe('conv-usage-key-1:elevenlabs:agent_minute');
    });

    it('omite un asiento (nunca inventa tarifa) cuando no hay provider_rates vigente en esa fecha, y lo advierte por log', async () => {
        const fastify = buildFakeFastify();
        const entries = await resolveCallUsageEntries(fastify, {
            organizationId: REAL_ORG_ID,
            conversationId: 'conv-usage-sin-tarifa',
            durationSeconds: 60,
            occurredAt: new Date('1999-01-01T00:00:00Z'), // anterior a cualquier effective_from sembrado
            hasPhoneCallLeg: true,
        });

        expect(entries).toHaveLength(0);
        expect(fastify.log.warn).toHaveBeenCalled();
    });

    it('contraparte de éxito: con fecha dentro de rango, no se omite ni se advierte nada', async () => {
        const fastify = buildFakeFastify();
        const entries = await resolveCallUsageEntries(fastify, {
            organizationId: REAL_ORG_ID,
            conversationId: 'conv-usage-con-tarifa',
            durationSeconds: 60,
            occurredAt: new Date('2026-08-15T00:00:00Z'),
            hasPhoneCallLeg: true,
        });

        expect(entries).toHaveLength(2);
        expect(fastify.log.warn).not.toHaveBeenCalled();
    });
});
