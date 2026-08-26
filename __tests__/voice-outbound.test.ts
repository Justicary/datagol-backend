import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import voiceRoutes from '../src/routes/voice.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { ElevenLabsAdapter } from '../src/services/providers/ElevenLabsAdapter.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

/**
 * docs/tasks/outbound-lead-persistence-and-rate-limit.md — Problema 1 y 2.
 *
 * `ElevenLabsAdapter.triggerOutboundCall` se mockea en el prototipo: la
 * factoría de proveedores (VoiceProviderFactory) mantiene un singleton
 * construido una sola vez al importar el módulo, así que espiar la instancia
 * misma no serviría entre archivos de prueba — el mock debe vivir en el
 * prototipo para interceptar cualquier instancia ya construida. Nada de red
 * real a ElevenLabs en este archivo.
 */
function mockTriggerOutboundCall(implementation: (params: any) => Promise<{ callId: string }>) {
    return vi.spyOn(ElevenLabsAdapter.prototype, 'triggerOutboundCall').mockImplementation(async (params: any) => {
        const { callId } = await implementation(params);
        return { callId, status: 'queued', provider: 'elevenlabs', rawResponse: {} };
    });
}

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(voiceRoutes);
    await app.ready();
    return app;
}

async function cleanupAttempts(sourceIps: string[], phones: string[]) {
    if (sourceIps.length) {
        await supabaseAdmin.from('outbound_call_attempts').delete().in('source_ip', sourceIps);
    }
    if (phones.length) {
        await supabaseAdmin.from('outbound_call_attempts').delete().in('target_phone_raw', phones);
    }
}

describe('POST /api/voice/outbound', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe('Problema 2 — límite de tasa', () => {
        it('permite hasta 3 llamadas/hora por IP a números distintos, la 4ª recibe 429 (política aprobada por el usuario)', async () => {
            const runId = Date.now();
            const ip = `10.0.${runId % 200}.1`;
            const phones = [1, 2, 3, 4].map((n) => `+52165100${runId % 1000}${n}`);

            mockTriggerOutboundCall(async () => ({ callId: `conv_iprate_${runId}` }));

            const app = await buildTestApp();
            try {
                const responses = [];
                for (const phone of phones) {
                    responses.push(
                        await app.inject({
                            method: 'POST',
                            url: '/api/voice/outbound',
                            headers: { 'x-forwarded-for': ip },
                            payload: { customerPhone: phone },
                        })
                    );
                }

                expect(responses[0].statusCode).toBe(200);
                expect(responses[1].statusCode).toBe(200);
                expect(responses[2].statusCode).toBe(200);
                expect(responses[3].statusCode).toBe(429);
                expect(responses[3].json().message).toMatch(/origen/i);
            } finally {
                await app.close();
                await cleanupAttempts([ip], phones);
            }
        });

        it('permite hasta 2 llamadas/día al mismo número (aunque vengan de IPs distintas), la 3ª recibe 429', async () => {
            const runId = Date.now();
            const phone = `+52165200${runId % 10000}`;
            const ips = [1, 2, 3].map((n) => `10.1.${runId % 200}.${n}`);

            mockTriggerOutboundCall(async () => ({ callId: `conv_phonerate_${runId}` }));

            const app = await buildTestApp();
            try {
                const responses = [];
                for (const ip of ips) {
                    responses.push(
                        await app.inject({
                            method: 'POST',
                            url: '/api/voice/outbound',
                            headers: { 'x-forwarded-for': ip },
                            payload: { customerPhone: phone },
                        })
                    );
                }

                expect(responses[0].statusCode).toBe(200);
                expect(responses[1].statusCode).toBe(200);
                expect(responses[2].statusCode).toBe(429);
                expect(responses[2].json().message).toMatch(/número/i);
            } finally {
                await app.close();
                await cleanupAttempts(ips, [phone]);
            }
        });

        it('un intento rechazado por límite no llama al proveedor de voz (no genera un lead falso, docs/tasks §Orden de implementación)', async () => {
            const runId = Date.now();
            const phone = `+52165300${runId % 10000}`;
            // Mismo número, IPs distintas: agota el límite por teléfono (2/día),
            // no el de IP, para aislar exactamente lo que este test verifica.
            const ips = [`10.2.${runId % 200}.1`, `10.2.${runId % 200}.2`, `10.2.${runId % 200}.3`];

            const trigger = mockTriggerOutboundCall(async () => ({ callId: `conv_shouldnotcall_${runId}` }));

            const app = await buildTestApp();
            try {
                await app.inject({ method: 'POST', url: '/api/voice/outbound', headers: { 'x-forwarded-for': ips[0] }, payload: { customerPhone: phone } });
                await app.inject({ method: 'POST', url: '/api/voice/outbound', headers: { 'x-forwarded-for': ips[1] }, payload: { customerPhone: phone } });
                trigger.mockClear();

                const blocked = await app.inject({
                    method: 'POST',
                    url: '/api/voice/outbound',
                    headers: { 'x-forwarded-for': ips[2] },
                    payload: { customerPhone: phone },
                });

                expect(blocked.statusCode).toBe(429);
                expect(trigger).not.toHaveBeenCalled();
            } finally {
                await app.close();
                await cleanupAttempts(ips, [phone]);
            }
        });

        it('cuenta también los intentos fallidos del proveedor (no solo los que conectan)', async () => {
            const runId = Date.now();
            const ip = `10.3.${runId % 200}.1`;
            const phones = [1, 2, 3, 4].map((n) => `+52165400${runId % 1000}${n}`);

            mockTriggerOutboundCall(async () => {
                throw new Error('Fallo simulado del proveedor de voz');
            });

            const app = await buildTestApp();
            try {
                const responses = [];
                for (const phone of phones) {
                    responses.push(
                        await app.inject({
                            method: 'POST',
                            url: '/api/voice/outbound',
                            headers: { 'x-forwarded-for': ip },
                            payload: { customerPhone: phone },
                        })
                    );
                }

                // Las primeras 3 fallan en el proveedor (500), pero cuentan como intento.
                expect(responses[0].statusCode).toBe(500);
                expect(responses[1].statusCode).toBe(500);
                expect(responses[2].statusCode).toBe(500);
                // La 4ª ni siquiera llega al proveedor: el límite de IP ya se alcanzó.
                expect(responses[3].statusCode).toBe(429);
            } finally {
                await app.close();
                await cleanupAttempts([ip], phones);
            }
        });
    });

    describe('Problema 1 — siembra inmediata de leads con los datos del formulario', () => {
        it('crea contacts/call_logs/leads en cuanto el proveedor confirma el conversation_id, con los datos del formulario (customerEmail/industry incluidos)', async () => {
            const runId = Date.now();
            const ip = `10.4.${runId % 200}.1`;
            // Área 222 (Puebla) + 7 dígitos con padding fijo: normalizePhoneE164
            // (libphonenumber-js) sí lo acepta como número MX válido — a
            // diferencia de un sufijo sin padding de longitud variable, que
            // produce números que libphonenumber rechaza silenciosamente
            // (verificado directo contra normalizePhoneE164 antes de escribir esto).
            const phone = `+52222${String(runId % 10000000).padStart(7, '0')}`;
            const conversationId = `conv_seed_test_${runId}`;

            mockTriggerOutboundCall(async () => ({ callId: conversationId }));

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/voice/outbound',
                    headers: { 'x-forwarded-for': ip },
                    payload: {
                        organizationId: REAL_ORG_ID,
                        customerPhone: phone,
                        customerName: 'Roberto Díaz',
                        customerEmail: 'roberto@example.com',
                        companyName: 'Ferretería Díaz',
                        industry: 'Ferretería',
                        demoObjective: 'Quiere ver el agente en acción',
                    },
                });

                expect(response.statusCode).toBe(200);

                const { data: lead } = await supabaseAdmin
                    .from('leads')
                    .select('full_name, email, business_name, business_sector, inquiry_reason, contact_phone')
                    .eq('organization_id', REAL_ORG_ID)
                    .eq('conversation_id', conversationId)
                    .single();

                expect(lead?.full_name).toBe('Roberto Díaz');
                expect(lead?.email).toBe('roberto@example.com');
                expect(lead?.business_name).toBe('Ferretería Díaz');
                expect(lead?.business_sector).toBe('Ferretería');
                expect(lead?.inquiry_reason).toBe('Quiere ver el agente en acción');

                const { data: contact } = await supabaseAdmin
                    .from('contacts')
                    .select('full_name, email, business_name, business_sector')
                    .eq('organization_id', REAL_ORG_ID)
                    .eq('phone_e164', phone)
                    .maybeSingle();

                expect(contact?.full_name).toBe('Roberto Díaz');
                expect(contact?.email).toBe('roberto@example.com');

                const { data: callLog } = await supabaseAdmin
                    .from('call_logs')
                    .select('customer_name, customer_email')
                    .eq('provider_call_id', conversationId)
                    .maybeSingle();

                expect(callLog?.customer_name).toBe('Roberto Díaz');
            } finally {
                await app.close();
                await cleanupAttempts([ip], [phone]);
                await supabaseAdmin.from('leads').delete().eq('conversation_id', conversationId);
                await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', conversationId);
                await supabaseAdmin.from('contacts').delete().eq('phone_e164', phone);
            }
        });

        it('un fallo al sembrar el lead no tumba la respuesta al frontend: la llamada real ya se disparó y cuesta dinero de cualquier forma', async () => {
            const runId = Date.now();
            const ip = `10.5.${runId % 200}.1`;
            const phone = `+52223${String(runId % 10000000).padStart(7, '0')}`;
            const conversationId = `conv_seedfail_test_${runId}`;

            mockTriggerOutboundCall(async () => ({ callId: conversationId }));
            // organizationId inexistente: el RPC falla por la FK de organization_id,
            // pero la ruta debe seguir respondiendo 200 con el resultado de la llamada.
            const fakeOrgId = '00000000-0000-0000-0000-000000000000';

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/voice/outbound',
                    headers: { 'x-forwarded-for': ip },
                    payload: {
                        organizationId: fakeOrgId,
                        customerPhone: phone,
                        customerName: 'Prospecto de Prueba',
                    },
                });

                expect(response.statusCode).toBe(200);
                expect(response.json().data.callId).toBe(conversationId);
            } finally {
                await app.close();
                await cleanupAttempts([ip], [phone]);
                await supabaseAdmin.from('leads').delete().eq('conversation_id', conversationId);
                await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', conversationId);
                await supabaseAdmin.from('contacts').delete().eq('phone_e164', phone);
            }
        });
    });

    describe('Extracción de agentId / agent_id y customVariables de req.body', () => {
        it('extrae agentId y customVariables de req.body y los pasa al proveedor de voz', async () => {
            const runId = Date.now();
            const ip = `10.6.${runId % 200}.1`;
            const phone = `+52224${String(runId % 10000000).padStart(7, '0')}`;
            let capturedParams: any = null;

            mockTriggerOutboundCall(async (params) => {
                capturedParams = params;
                return { callId: `conv_agentid_${runId}` };
            });

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/voice/outbound',
                    headers: { 'x-forwarded-for': ip },
                    payload: {
                        organizationId: REAL_ORG_ID,
                        agentId: 'agent_override_abc',
                        customerPhone: phone,
                        customerName: 'Cliente Test',
                        customVariables: {
                            origen: 'landing_demo',
                            prioridad: 'alta',
                        },
                    },
                });

                expect(response.statusCode).toBe(200);
                expect(capturedParams).not.toBeNull();
                expect(capturedParams.agentId).toBe('agent_override_abc');
                expect(capturedParams.customVariables).toEqual({
                    origen: 'landing_demo',
                    prioridad: 'alta',
                });
            } finally {
                await app.close();
                await cleanupAttempts([ip], [phone]);
                await supabaseAdmin.from('leads').delete().eq('conversation_id', `conv_agentid_${runId}`);
                await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', `conv_agentid_${runId}`);
                await supabaseAdmin.from('contacts').delete().eq('phone_e164', phone);
            }
        });

        it('extrae agent_id (formato snake_case) cuando viene en req.body y lo pasa como agentId', async () => {
            const runId = Date.now();
            const ip = `10.6.${runId % 200}.2`;
            const phone = `+52224${String((runId + 1) % 10000000).padStart(7, '0')}`;
            let capturedParams: any = null;

            mockTriggerOutboundCall(async (params) => {
                capturedParams = params;
                return { callId: `conv_agent_snake_${runId}` };
            });

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/voice/outbound',
                    headers: { 'x-forwarded-for': ip },
                    payload: {
                        organizationId: REAL_ORG_ID,
                        agent_id: 'agent_snake_case_xyz',
                        customerPhone: phone,
                        customerName: 'Cliente Snake',
                    },
                });

                expect(response.statusCode).toBe(200);
                expect(capturedParams).not.toBeNull();
                expect(capturedParams.agentId).toBe('agent_snake_case_xyz');
            } finally {
                await app.close();
                await cleanupAttempts([ip], [phone]);
                await supabaseAdmin.from('leads').delete().eq('conversation_id', `conv_agent_snake_${runId}`);
                await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', `conv_agent_snake_${runId}`);
                await supabaseAdmin.from('contacts').delete().eq('phone_e164', phone);
            }
        });
    });
});
