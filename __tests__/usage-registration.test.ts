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

const NO_LLM_USAGE_WARN_MATCHER = expect.stringContaining('tokens de LLM');

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
            isTextChannel: false,
            textMessageQuantity: null,
            llmTokenUsage: [],
        });

        expect(entries).toHaveLength(1);
        expect(entries[0].provider).toBe('elevenlabs');
        expect(entries[0].unit_type).toBe('agent_minute');
        expect(entries[0].quantity).toBeCloseTo(2, 5); // 120s = 2 minutos
        // llmTokenUsage vacío SÍ advierte (ver describe "tokens de LLM" más
        // abajo) — pero no debe haber ninguna advertencia de tarifa faltante
        // para agent_minute, que sí tiene tarifa vigente.
        expect(fastify.log.warn).toHaveBeenCalledTimes(1);
        expect(fastify.log.warn).toHaveBeenCalledWith(expect.anything(), NO_LLM_USAGE_WARN_MATCHER);
    });

    it('agrega también sip_inbound_local_mx cuando sí hubo tramo de telefonía (contraparte de éxito)', async () => {
        const fastify = buildFakeFastify();
        const entries = await resolveCallUsageEntries(fastify, {
            organizationId: REAL_ORG_ID,
            conversationId: 'conv-usage-phone-1',
            durationSeconds: 200,
            occurredAt: new Date('2026-08-15T00:00:00Z'),
            hasPhoneCallLeg: true,
            isTextChannel: false,
            textMessageQuantity: null,
            llmTokenUsage: [],
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
            isTextChannel: false,
            textMessageQuantity: null,
            llmTokenUsage: [],
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
            isTextChannel: false,
            textMessageQuantity: null,
            llmTokenUsage: [],
        });

        expect(entries).toHaveLength(0);
        expect(fastify.log.warn).toHaveBeenCalled();
    });

    it('contraparte de éxito: con fecha dentro de rango y tokens de LLM presentes, no se omite ni se advierte nada', async () => {
        const fastify = buildFakeFastify();
        const entries = await resolveCallUsageEntries(fastify, {
            organizationId: REAL_ORG_ID,
            conversationId: 'conv-usage-con-tarifa',
            durationSeconds: 60,
            occurredAt: new Date('2026-08-15T00:00:00Z'),
            hasPhoneCallLeg: true,
            isTextChannel: false,
            textMessageQuantity: null,
            llmTokenUsage: [{ model: 'gemini-2.5-flash', inputTokens: 100, outputTokens: 20 }],
        });

        // agent_minute + sip_inbound_local_mx + llm_input_token + llm_output_token
        expect(entries).toHaveLength(4);
        expect(fastify.log.warn).not.toHaveBeenCalled();
    });

    /**
     * URGENTE (reportado por el usuario): `agent_minute` no aplica a
     * conversaciones de WhatsApp — ElevenLabs no sintetiza audio para ese
     * canal, así que `call_duration_secs` no mide minutos de voz. Antes de
     * este fix, `buildCallUsageCandidates` ignoraba el canal por completo y
     * siempre derivaba `agent_minute` de `durationSeconds`, sobrefacturando
     * cualquier conversación de WhatsApp con la tarifa de voz.
     */
    describe('canales de texto (WhatsApp): agent_minute nunca aplica', () => {
        it('un payload de WhatsApp con duración de 600s no produce ningún asiento de agent_minute', async () => {
            const fastify = buildFakeFastify();
            const entries = await resolveCallUsageEntries(fastify, {
                organizationId: REAL_ORG_ID,
                conversationId: 'conv-usage-whatsapp-sin-minutos',
                durationSeconds: 600,
                occurredAt: new Date('2026-08-15T00:00:00Z'),
                hasPhoneCallLeg: false,
                isTextChannel: true,
                textMessageQuantity: null,
                llmTokenUsage: [],
            });

            expect(entries.find((e) => e.unit_type === 'agent_minute')).toBeUndefined();
            expect(entries.find((e) => e.unit_type === 'sip_inbound_local_mx')).toBeUndefined();
        });

        it('contraparte de éxito: registra wa_message con la cantidad de platform_usage.category_usage.text_message.quantity', async () => {
            const fastify = buildFakeFastify();
            const entries = await resolveCallUsageEntries(fastify, {
                organizationId: REAL_ORG_ID,
                conversationId: 'conv-usage-whatsapp-con-mensajes',
                durationSeconds: 600,
                occurredAt: new Date('2026-08-15T00:00:00Z'),
                hasPhoneCallLeg: false,
                isTextChannel: true,
                textMessageQuantity: 7,
                llmTokenUsage: [],
            });

            const waEntry = entries.find((e) => e.unit_type === 'wa_message');
            expect(waEntry?.provider).toBe('elevenlabs');
            expect(waEntry?.quantity).toBe(7);
            expect(waEntry?.idempotency_key).toBe('conv-usage-whatsapp-con-mensajes:elevenlabs:wa_message');
        });

        it('sin platform_usage.category_usage.text_message.quantity (null), no inventa una cantidad: no produce ningún asiento de wa_message', async () => {
            const fastify = buildFakeFastify();
            const entries = await resolveCallUsageEntries(fastify, {
                organizationId: REAL_ORG_ID,
                conversationId: 'conv-usage-whatsapp-sin-cantidad',
                durationSeconds: 600,
                occurredAt: new Date('2026-08-15T00:00:00Z'),
                hasPhoneCallLeg: false,
                isTextChannel: true,
                textMessageQuantity: null,
                llmTokenUsage: [],
            });

            expect(entries.find((e) => e.unit_type === 'wa_message')).toBeUndefined();
        });

        it('una cantidad negativa (dato corrupto/imposible) no genera un asiento: no se trata como "valor presente" solo por ser distinto de null', async () => {
            const fastify = buildFakeFastify();
            const entries = await resolveCallUsageEntries(fastify, {
                organizationId: REAL_ORG_ID,
                conversationId: 'conv-usage-whatsapp-cantidad-negativa',
                durationSeconds: 600,
                occurredAt: new Date('2026-08-15T00:00:00Z'),
                hasPhoneCallLeg: false,
                isTextChannel: true,
                textMessageQuantity: -5,
                llmTokenUsage: [],
            });

            expect(entries.find((e) => e.unit_type === 'wa_message')).toBeUndefined();
        });

        it('un payload de WhatsApp que además trajera phone_call (dato inconsistente) sigue sin generar agent_minute ni sip_inbound_local_mx: nunca se deriva consumo de duración cuando el canal es de texto', async () => {
            const fastify = buildFakeFastify();
            const entries = await resolveCallUsageEntries(fastify, {
                organizationId: REAL_ORG_ID,
                conversationId: 'conv-usage-whatsapp-hasphonecall-inconsistente',
                durationSeconds: 600,
                occurredAt: new Date('2026-08-15T00:00:00Z'),
                hasPhoneCallLeg: true, // caso defensivo: no debería pasar en la práctica, pero isTextChannel manda igual
                isTextChannel: true,
                textMessageQuantity: 3,
                llmTokenUsage: [],
            });

            expect(entries.find((e) => e.unit_type === 'agent_minute')).toBeUndefined();
            expect(entries.find((e) => e.unit_type === 'sip_inbound_local_mx')).toBeUndefined();
            expect(entries.find((e) => e.unit_type === 'wa_message')).toBeDefined();
        });
    });

    /**
     * Tokens de LLM — cierra el hueco del 14% de la factura. Los asientos
     * `llm_input_token_<modelo>`/`llm_output_token_<modelo>` requieren la
     * tarifa sembrada en db/migrations/15_llm_token_provider_rates.sql
     * (provider='elevenlabs', modelo 'gemini-2.5-flash' con effective_from
     * 2026-05-01) — mismo patrón de dependencia que ya tenían las pruebas de
     * sip_inbound_local_mx contra la migración de tarifas de Telnyx.
     */
    describe('tokens de LLM (metadata.charging.llm_usage.irreversible_generation.model_usage)', () => {
        it('en una llamada de voz, registra llm_input_token/llm_output_token del modelo junto con agent_minute', async () => {
            const fastify = buildFakeFastify();
            const entries = await resolveCallUsageEntries(fastify, {
                organizationId: REAL_ORG_ID,
                conversationId: 'conv-usage-llm-voz',
                durationSeconds: 60,
                occurredAt: new Date('2026-08-15T00:00:00Z'),
                hasPhoneCallLeg: false,
                isTextChannel: false,
                textMessageQuantity: null,
                llmTokenUsage: [{ model: 'gemini-2.5-flash', inputTokens: 9735, outputTokens: 28 }],
            });

            expect(entries.find((e) => e.unit_type === 'agent_minute')).toBeDefined();
            const inputEntry = entries.find((e) => e.unit_type === 'llm_input_token_gemini-2.5-flash');
            const outputEntry = entries.find((e) => e.unit_type === 'llm_output_token_gemini-2.5-flash');
            expect(inputEntry?.provider).toBe('elevenlabs');
            expect(inputEntry?.quantity).toBe(9735);
            expect(inputEntry?.unit_rate_usd).toBeCloseTo(0.00000015, 12);
            expect(outputEntry?.quantity).toBe(28);
            expect(outputEntry?.unit_rate_usd).toBeCloseTo(0.0000006, 12);
            expect(inputEntry?.idempotency_key).toBe('conv-usage-llm-voz:elevenlabs:llm_input_token_gemini-2.5-flash');
        });

        it('contraparte de éxito: en un canal de texto (WhatsApp), también registra tokens de LLM junto con wa_message', async () => {
            const fastify = buildFakeFastify();
            const entries = await resolveCallUsageEntries(fastify, {
                organizationId: REAL_ORG_ID,
                conversationId: 'conv-usage-llm-whatsapp',
                durationSeconds: 600,
                occurredAt: new Date('2026-08-15T00:00:00Z'),
                hasPhoneCallLeg: false,
                isTextChannel: true,
                textMessageQuantity: 1,
                llmTokenUsage: [{ model: 'gemini-2.5-flash', inputTokens: 500, outputTokens: 50 }],
            });

            expect(entries.find((e) => e.unit_type === 'wa_message')).toBeDefined();
            expect(entries.find((e) => e.unit_type === 'llm_input_token_gemini-2.5-flash')).toBeDefined();
            expect(entries.find((e) => e.unit_type === 'llm_output_token_gemini-2.5-flash')).toBeDefined();
            expect(entries.find((e) => e.unit_type === 'agent_minute')).toBeUndefined();
        });

        it('con dos modelos en la misma conversación, registra 4 asientos (input+output por modelo)', async () => {
            const fastify = buildFakeFastify();
            const entries = await resolveCallUsageEntries(fastify, {
                organizationId: REAL_ORG_ID,
                conversationId: 'conv-usage-llm-dos-modelos',
                durationSeconds: 60,
                occurredAt: new Date('2026-08-15T00:00:00Z'),
                hasPhoneCallLeg: false,
                isTextChannel: false,
                textMessageQuantity: null,
                llmTokenUsage: [
                    { model: 'gemini-2.5-flash', inputTokens: 100, outputTokens: 10 },
                    { model: 'gpt-4o', inputTokens: 50, outputTokens: 5 },
                ],
            });

            expect(entries.find((e) => e.unit_type === 'llm_input_token_gemini-2.5-flash')?.quantity).toBe(100);
            expect(entries.find((e) => e.unit_type === 'llm_output_token_gemini-2.5-flash')?.quantity).toBe(10);
            expect(entries.find((e) => e.unit_type === 'llm_input_token_gpt-4o')?.quantity).toBe(50);
            expect(entries.find((e) => e.unit_type === 'llm_output_token_gpt-4o')?.quantity).toBe(5);
        });

        it('contraparte de rechazo: llmTokenUsage vacío no inventa consumo y advierte con el conversation_id', async () => {
            const fastify = buildFakeFastify();
            const entries = await resolveCallUsageEntries(fastify, {
                organizationId: REAL_ORG_ID,
                conversationId: 'conv-usage-llm-vacio',
                durationSeconds: 60,
                occurredAt: new Date('2026-08-15T00:00:00Z'),
                hasPhoneCallLeg: false,
                isTextChannel: false,
                textMessageQuantity: null,
                llmTokenUsage: [],
            });

            expect(entries.find((e) => e.unit_type?.startsWith('llm_'))).toBeUndefined();
            expect(fastify.log.warn).toHaveBeenCalledWith(
                expect.objectContaining({ organizationId: REAL_ORG_ID, conversationId: 'conv-usage-llm-vacio' }),
                NO_LLM_USAGE_WARN_MATCHER
            );
        });

        it('un modelo sin tarifa sembrada en provider_rates se omite (nunca inventa un precio) y lo advierte por log, sin tumbar los demás asientos', async () => {
            const fastify = buildFakeFastify();
            const entries = await resolveCallUsageEntries(fastify, {
                organizationId: REAL_ORG_ID,
                conversationId: 'conv-usage-llm-modelo-desconocido',
                durationSeconds: 60,
                occurredAt: new Date('2026-08-15T00:00:00Z'),
                hasPhoneCallLeg: false,
                isTextChannel: false,
                textMessageQuantity: null,
                llmTokenUsage: [{ model: 'modelo-inexistente-diagnostico', inputTokens: 100, outputTokens: 10 }],
            });

            expect(entries.find((e) => e.unit_type === 'agent_minute')).toBeDefined();
            expect(entries.find((e) => e.unit_type?.includes('modelo-inexistente-diagnostico'))).toBeUndefined();
            expect(fastify.log.warn).toHaveBeenCalledWith(
                expect.objectContaining({ unitType: 'llm_input_token_modelo-inexistente-diagnostico' }),
                expect.stringContaining('no hay tarifa vigente')
            );
        });
    });
});
