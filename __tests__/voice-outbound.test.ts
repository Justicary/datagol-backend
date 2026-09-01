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
            // Área 225 + 7 dígitos con padding fijo: mismo criterio de
            // normalizePhoneE164 documentado más abajo (área 222) — un
            // sufijo sin padding de longitud variable produce números que
            // libphonenumber-js rechaza silenciosamente, y desde Zero Lead
            // Loss (§3.1) un teléfono que no normaliza responde 400 antes
            // de llegar siquiera al límite de tasa.
            const phones = [1, 2, 3, 4].map((n) => `+52225${String((runId + n) % 10000000).padStart(7, '0')}`);

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
            const phone = `+52226${String(runId % 10000000).padStart(7, '0')}`;
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
            const phone = `+52227${String(runId % 10000000).padStart(7, '0')}`;
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
            const phones = [1, 2, 3, 4].map((n) => `+52228${String((runId + n) % 10000000).padStart(7, '0')}`);

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

    describe('Problema 1 — siembra inmediata de leads con los datos del formulario (Store-First)', () => {
        it('crea contacts/leads ANTES de marcar (store-first) y enlaza call_logs/conversation_id al confirmar el proveedor, con los datos del formulario (customerEmail/industry incluidos)', async () => {
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
                const body = response.json();
                expect(body.data.leadId).toBeTruthy();
                expect(body.data.contactId).toBeTruthy();
                expect(body.data.callStatus).toBe('initiated');

                const { data: lead } = await supabaseAdmin
                    .from('leads')
                    .select('id, full_name, email, business_name, business_sector, inquiry_reason, contact_phone, conversation_id, call_log_id, source')
                    .eq('organization_id', REAL_ORG_ID)
                    .eq('conversation_id', conversationId)
                    .single();

                // La fila es la MISMA que se sembró antes de marcar (mismo id
                // que trajo la respuesta HTTP) — nunca se duplicó al enlazar
                // el conversation_id real.
                expect(lead?.id).toBe(body.data.leadId);
                expect(lead?.full_name).toBe('Roberto Díaz');
                expect(lead?.email).toBe('roberto@example.com');
                expect(lead?.business_name).toBe('Ferretería Díaz');
                expect(lead?.business_sector).toBe('Ferretería');
                expect(lead?.inquiry_reason).toBe('Quiere ver el agente en acción');
                expect(lead?.call_log_id).toBeTruthy();
                expect(lead?.source).toBe('sitio_web');

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
            }
        });

        it('PRUEBA CENTRAL DEL INCIDENTE: el lead ya existe en la base ANTES de que se invoque al proveedor de voz — no depende de que la llamada conteste', async () => {
            const runId = Date.now();
            const ip = `10.4.${runId % 200}.2`;
            const phone = `+52222${String((runId + 1) % 10000000).padStart(7, '0')}`;
            const conversationId = `conv_storefirst_order_${runId}`;
            let leadExistedBeforeDialing = false;
            let leadHadNullConversationIdBeforeDialing = false;

            mockTriggerOutboundCall(async () => {
                // Se consulta la base DESDE DENTRO del mock del proveedor —
                // si store-first funciona, el lead ya debe existir en este
                // punto exacto, con conversation_id todavía NULL (el
                // proveedor ni siquiera ha respondido con uno real).
                const { data: preExisting } = await supabaseAdmin
                    .from('leads')
                    .select('conversation_id')
                    .eq('organization_id', REAL_ORG_ID)
                    .eq('contact_phone', phone)
                    .maybeSingle();
                leadExistedBeforeDialing = !!preExisting;
                leadHadNullConversationIdBeforeDialing = preExisting?.conversation_id === null;
                return { callId: conversationId };
            });

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/voice/outbound',
                    headers: { 'x-forwarded-for': ip },
                    payload: {
                        organizationId: REAL_ORG_ID,
                        customerPhone: phone,
                        customerName: 'Prospecto Orden De Persistencia',
                    },
                });

                expect(response.statusCode).toBe(200);
                expect(leadExistedBeforeDialing).toBe(true);
                expect(leadHadNullConversationIdBeforeDialing).toBe(true);
            } finally {
                await app.close();
                await cleanupAttempts([ip], [phone]);
                await supabaseAdmin.from('leads').delete().eq('conversation_id', conversationId);
                await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', conversationId);
                await supabaseAdmin.from('contacts').delete().eq('phone_e164', phone);
            }
        });

        it('docs/tasks/zero-lead-loss-outbound-persistence.md — si la siembra previa falla, NUNCA se marca (regla de oro store-first)', async () => {
            const runId = Date.now();
            const ip = `10.5.${runId % 200}.1`;
            const phone = `+52223${String(runId % 10000000).padStart(7, '0')}`;
            const conversationId = `conv_seedfail_test_${runId}`;

            const trigger = mockTriggerOutboundCall(async () => ({ callId: conversationId }));
            // organizationId inexistente: seed_outbound_lead falla por la FK de
            // organization_id ANTES de intentar marcar — gastar el minuto de
            // ElevenLabs por un prospecto que de todas formas no se puede
            // persistir no tiene sentido (Regla de Oro, §2).
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

                expect(response.statusCode).toBe(500);
                expect(trigger).not.toHaveBeenCalled();
            } finally {
                await app.close();
                await cleanupAttempts([ip], [phone]);
                await supabaseAdmin.from('leads').delete().eq('conversation_id', conversationId);
                await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', conversationId);
                await supabaseAdmin.from('contacts').delete().eq('phone_e164', phone);
            }
        });

        it('contraparte de éxito: si ElevenLabs falla DESPUÉS de la siembra, el lead ya guardado se anota y la ruta responde 200 (callStatus: call_failed_lead_saved)', async () => {
            const runId = Date.now();
            const ip = `10.5.${runId % 200}.2`;
            const phone = `+52223${String((runId + 1) % 10000000).padStart(7, '0')}`;

            mockTriggerOutboundCall(async () => {
                throw new Error('SIP 500: carrier no disponible');
            });

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/voice/outbound',
                    headers: { 'x-forwarded-for': ip },
                    payload: {
                        organizationId: REAL_ORG_ID,
                        customerPhone: phone,
                        customerName: 'Prospecto Que No Contestó',
                        customerEmail: 'prospecto-nocontesto@example.com',
                        companyName: 'Negocio de Prueba',
                        industry: 'Retail',
                        demoObjective: 'Quiere una demo',
                    },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.status).toBe('success');
                expect(body.data.callStatus).toBe('call_failed_lead_saved');
                expect(body.data.leadId).toBeTruthy();
                expect(body.data.contactId).toBeTruthy();

                const { data: lead } = await supabaseAdmin
                    .from('leads')
                    .select('full_name, email, business_name, needs_followup, followup_status, followup_notes, conversation_id')
                    .eq('id', body.data.leadId)
                    .single();

                // El prospecto sigue visible con TODOS los datos del formulario,
                // aunque la llamada nunca haya conectado — el criterio de
                // aceptación central de esta tarea.
                expect(lead?.full_name).toBe('Prospecto Que No Contestó');
                expect(lead?.email).toBe('prospecto-nocontesto@example.com');
                expect(lead?.business_name).toBe('Negocio de Prueba');
                expect(lead?.needs_followup).toBe(true);
                expect(lead?.followup_status).toBe('pendiente');
                expect(lead?.followup_notes).toMatch(/SIP 500: carrier no disponible/);
                expect(lead?.followup_notes).toMatch(/Requiere contacto manual/);
                expect(lead?.conversation_id).toBeNull();

                const { data: contact } = await supabaseAdmin
                    .from('contacts')
                    .select('id')
                    .eq('id', body.data.contactId)
                    .maybeSingle();
                expect(contact).toBeTruthy();
            } finally {
                await app.close();
                await cleanupAttempts([ip], [phone]);
                await supabaseAdmin.from('leads').delete().eq('contact_phone', phone);
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
                // docs/tasks/zero-lead-loss-outbound-persistence.md §3.3 — con
                // organizationId presente, la ruta mezcla leadId/contactId de
                // la siembra store-first dentro de customVariables (para que
                // ElevenLabs los conserve en la metadata de la llamada), sin
                // perder las variables originales del body.
                expect(capturedParams.customVariables).toMatchObject({
                    origen: 'landing_demo',
                    prioridad: 'alta',
                    leadId: expect.any(String),
                    contactId: expect.any(String),
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

        it('cuando action es confirm_appointment y viene appointmentId, actualiza confirmation_requested_at en la cita', async () => {
            const runId = Date.now();
            const ip = `10.6.${runId % 200}.3`;
            const phone = `+52224${String((runId + 2) % 10000000).padStart(7, '0')}`;

            mockTriggerOutboundCall(async () => {
                return { callId: `conv_confirm_appt_${runId}` };
            });

            const { data: contact } = await supabaseAdmin
                .from('contacts')
                .insert({ organization_id: REAL_ORG_ID, phone_e164: phone, full_name: 'Cliente Confirmación' })
                .select('id')
                .single();

            const { data: appt } = await supabaseAdmin
                .from('appointments')
                .insert({
                    organization_id: REAL_ORG_ID,
                    contact_id: contact?.id,
                    customer_name: 'Cliente Confirmación',
                    customer_phone: phone,
                    start_time: new Date(Date.now() + 86400000).toISOString(),
                    end_time: new Date(Date.now() + 86400000 + 1800000).toISOString(),
                    status: 'programada',
                })
                .select('id')
                .single();

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/voice/outbound',
                    headers: { 'x-forwarded-for': ip },
                    payload: {
                        organizationId: REAL_ORG_ID,
                        customerPhone: phone,
                        customerName: 'Cliente Confirmación',
                        action: 'confirm_appointment',
                        appointmentId: appt?.id,
                        demoObjective: 'Confirmación de cita agendada',
                    },
                });

                expect(response.statusCode).toBe(200);

                const { data: updatedAppt } = await supabaseAdmin
                    .from('appointments')
                    .select('confirmation_requested_at')
                    .eq('id', appt?.id)
                    .single();

                expect(updatedAppt?.confirmation_requested_at).toBeTruthy();
            } finally {
                await app.close();
                await cleanupAttempts([ip], [phone]);
                if (appt?.id) await supabaseAdmin.from('appointments').delete().eq('id', appt.id);
                await supabaseAdmin.from('leads').delete().eq('conversation_id', `conv_confirm_appt_${runId}`);
                await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', `conv_confirm_appt_${runId}`);
                if (contact?.id) await supabaseAdmin.from('contacts').delete().eq('id', contact.id);
            }
        });
    });
});
