import { describe, it, expect } from 'vitest';
import { mapElevenLabsPayload } from '../src/services/call-payload-mapper.js';

function buildPayload(overrides: {
    type?: string;
    dataCollectionResults?: Record<string, unknown>;
    phoneCall?: { external_number?: string } | null;
    transcript?: Array<{ role: string; message: string }>;
} = {}) {
    return {
        type: overrides.type ?? 'post_call_transcription',
        event_timestamp: 1700000000,
        data: {
            agent_id: 'agent_123',
            conversation_id: 'conv_abc',
            transcript: overrides.transcript ?? [
                { role: 'agent', message: 'Hola, ¿en qué puedo ayudarte?' },
                { role: 'user', message: 'Quiero cotizar un servicio.' },
            ],
            analysis: {
                transcript_summary: 'El cliente pidió una cotización.',
                data_collection_results: overrides.dataCollectionResults,
            },
            metadata: {
                call_duration_secs: 185,
                phone_call: overrides.phoneCall,
            },
        },
    };
}

describe('2.2 — Mapeo del payload de post-llamada de ElevenLabs a leads', () => {
    it('mapea todas las claves de data_collection_results configuradas en el agente', () => {
        const payload = buildPayload({
            dataCollectionResults: {
                nombre_completo_prospecto: { value: 'Juana Pérez' },
                telefono_contacto_prospecto: { value: '2221234567' },
                correo_electronico_prospecto: { value: 'juana@example.com' },
                motivo_consulta: { value: 'Cotización de instalación' },
                cita_programada: { value: true },
                direccion_prospecto: { value: 'Calle Reforma 123' },
                ciudad_prospecto: { value: 'Puebla' },
                estado_prospecto: { value: 'Puebla' },
                cp_prospecto: { value: '72000' },
                nombre_negocio: { value: 'Ferretería Pérez' },
                giro_negocio: { value: 'Ferretería' },
                temperatura: { value: 'caliente' },
                requiere_seguimiento: { value: true },
                notas_seguimiento: { value: 'Llamar mañana para confirmar horario' },
                volumen_llamadas: { value: '10-20 al día' },
            },
        });

        const mapped = mapElevenLabsPayload(payload);

        expect(mapped).not.toBeNull();
        expect(mapped!.fullName).toBe('Juana Pérez');
        expect(mapped!.email).toBe('juana@example.com');
        expect(mapped!.inquiryReason).toBe('Cotización de instalación');
        expect(mapped!.bookedAppointment).toBe(true);
        expect(mapped!.address).toBe('Calle Reforma 123');
        expect(mapped!.city).toBe('Puebla');
        expect(mapped!.state).toBe('Puebla');
        expect(mapped!.zip).toBe('72000');
        expect(mapped!.businessName).toBe('Ferretería Pérez');
        expect(mapped!.businessSector).toBe('Ferretería');
        expect(mapped!.temperature).toBe('caliente');
        expect(mapped!.needsFollowup).toBe(true);
        expect(mapped!.followupNotes).toBe('Llamar mañana para confirmar horario');
        expect(mapped!.callVolume).toBe('10-20 al día');
        // Sin número de telefonía SIP, usa el teléfono dictado y lo normaliza a E.164
        expect(mapped!.callerPhoneE164).toBe('+522221234567');
        expect(mapped!.conversationId).toBe('conv_abc');
        expect(mapped!.providerCallId).toBe('conv_abc');
        expect(mapped!.durationSeconds).toBe(185);
    });

    it('mapea el payload real de producción: solo los 5 campos que el agente captura hoy, el resto queda null/false sin lanzar (docs/tasks/elevenlabs-data-collection-key-mismatch.md)', () => {
        const payload = buildPayload({
            dataCollectionResults: {
                nombre_completo_prospecto: { value: 'Juana Pérez' },
                telefono_contacto_prospecto: { value: '2221234567' },
                correo_electronico_prospecto: { value: 'juana@example.com' },
                motivo_consulta: { value: 'Cotización de instalación' },
                cita_programada: { value: true },
                // nombre_negocio/giro_negocio/temperatura/requiere_seguimiento/
                // notas_seguimiento/volumen_llamadas: el agente aún no los
                // captura — ausentes, como en la captura real.
            },
        });

        const mapped = mapElevenLabsPayload(payload);

        expect(mapped).not.toBeNull();
        expect(mapped!.fullName).toBe('Juana Pérez');
        expect(mapped!.contactPhoneRaw).toBe('2221234567');
        expect(mapped!.callerPhoneE164).toBe('+522221234567');
        expect(mapped!.email).toBe('juana@example.com');
        expect(mapped!.inquiryReason).toBe('Cotización de instalación');
        expect(mapped!.bookedAppointment).toBe(true);

        expect(mapped!.address).toBeNull();
        expect(mapped!.city).toBeNull();
        expect(mapped!.state).toBeNull();
        expect(mapped!.zip).toBeNull();
        expect(mapped!.businessName).toBeNull();
        expect(mapped!.businessSector).toBeNull();
        expect(mapped!.temperature).toBeNull();
        expect(mapped!.needsFollowup).toBe(false);
        expect(mapped!.followupNotes).toBeNull();
        expect(mapped!.callVolume).toBeNull();
    });

    it('regla de honestidad de datos: sin data_collection_results, todos los campos quedan vacíos, ninguno inventado', () => {
        const payload = buildPayload({ dataCollectionResults: undefined });
        const mapped = mapElevenLabsPayload(payload);

        expect(mapped).not.toBeNull();
        expect(mapped!.fullName).toBeNull();
        expect(mapped!.email).toBeNull();
        expect(mapped!.address).toBeNull();
        expect(mapped!.city).toBeNull();
        expect(mapped!.state).toBeNull();
        expect(mapped!.zip).toBeNull();
        expect(mapped!.businessName).toBeNull();
        expect(mapped!.businessSector).toBeNull();
        expect(mapped!.inquiryReason).toBeNull();
        expect(mapped!.temperature).toBeNull();
        expect(mapped!.followupNotes).toBeNull();
        expect(mapped!.callVolume).toBeNull();
        expect(mapped!.callerPhoneE164).toBeNull();
        expect(mapped!.contactPhoneRaw).toBeNull();
        // Booleanos ausentes toman el valor neutro por defecto (false), no se infieren como true.
        expect(mapped!.bookedAppointment).toBe(false);
        expect(mapped!.needsFollowup).toBe(false);
    });

    it('no infiere email/teléfono/nombre a partir de la transcripción cuando data_collection_results no los trae', () => {
        const payload = buildPayload({
            dataCollectionResults: undefined,
            transcript: [
                { role: 'user', message: 'Soy Carlos Ramírez, mi correo es carlos@example.com y mi número es 5512345678' },
            ],
        });
        const mapped = mapElevenLabsPayload(payload);

        expect(mapped!.fullName).toBeNull();
        expect(mapped!.email).toBeNull();
        expect(mapped!.callerPhoneE164).toBeNull();
    });

    it('una temperatura fuera del CHECK constraint de leads.temperature se guarda como null, no se fuerza', () => {
        const payload = buildPayload({
            dataCollectionResults: {
                temperatura: { value: 'muy caliente' }, // no está en LEAD_TEMPERATURES
            },
        });
        const mapped = mapElevenLabsPayload(payload);
        expect(mapped!.temperature).toBeNull();
    });

    it('prioriza el número de telefonía (SIP) sobre el teléfono dictado por voz', () => {
        const payload = buildPayload({
            phoneCall: { external_number: '+522231234567' },
            dataCollectionResults: {
                telefono_contacto_prospecto: { value: '111' }, // número inválido/dictado erróneamente
            },
        });
        const mapped = mapElevenLabsPayload(payload);

        expect(mapped!.callerPhoneE164).toBe('+522231234567');
        expect(mapped!.contactPhoneRaw).toBe('111');
    });

    it('un número de teléfono inválido no aborta el mapeo del lead (queda sin contact_id)', () => {
        const payload = buildPayload({
            dataCollectionResults: {
                telefono_contacto_prospecto: { value: '123' },
                nombre_completo_prospecto: { value: 'Prospecto sin teléfono válido' },
            },
        });
        const mapped = mapElevenLabsPayload(payload);

        expect(mapped).not.toBeNull();
        expect(mapped!.callerPhoneE164).toBeNull();
        expect(mapped!.fullName).toBe('Prospecto sin teléfono válido');
    });

    it('devuelve null para tipos de evento fuera de alcance (p. ej. post_call_audio)', () => {
        const payload = buildPayload({ type: 'post_call_audio' });
        const mapped = mapElevenLabsPayload(payload);
        expect(mapped).toBeNull();
    });

    it('acepta valores escalares (no envueltos en { value }) en data_collection_results', () => {
        const payload = buildPayload({
            dataCollectionResults: {
                nombre_completo_prospecto: 'Ana Torres',
                cita_programada: false,
            },
        });
        const mapped = mapElevenLabsPayload(payload);
        expect(mapped!.fullName).toBe('Ana Torres');
        expect(mapped!.bookedAppointment).toBe(false);
    });

    describe('address/city/state/zip (dirección de servicio del prospecto, campos agregados por el usuario en Data Collection)', () => {
        it('mapea solo los campos de dirección presentes, sin inventar los ausentes', () => {
            const payload = buildPayload({
                dataCollectionResults: {
                    direccion_prospecto: { value: 'Av. Juárez 45' },
                    ciudad_prospecto: { value: 'Cholula' },
                    // estado_prospecto/cp_prospecto ausentes a propósito.
                },
            });
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.address).toBe('Av. Juárez 45');
            expect(mapped!.city).toBe('Cholula');
            expect(mapped!.state).toBeNull();
            expect(mapped!.zip).toBeNull();
        });

        it('contraparte de rechazo: sin ninguno de los 4 campos, address/city/state/zip quedan null', () => {
            const payload = buildPayload({ dataCollectionResults: { motivo_consulta: { value: 'Otra cosa' } } });
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.address).toBeNull();
            expect(mapped!.city).toBeNull();
            expect(mapped!.state).toBeNull();
            expect(mapped!.zip).toBeNull();
        });
    });

    describe('3.1/3.2 — occurredAt y hasPhoneCallLeg (soporte de metering)', () => {
        it('marca hasPhoneCallLeg=true cuando el payload trae metadata.phone_call (llamada real por SIP)', () => {
            const payload = buildPayload({ phoneCall: { external_number: '+522231234567' } });
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.hasPhoneCallLeg).toBe(true);
        });

        it('marca hasPhoneCallLeg=false cuando no hay metadata.phone_call (conversación de widget web)', () => {
            const payload = buildPayload({ phoneCall: undefined });
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.hasPhoneCallLeg).toBe(false);
        });

        it('no lanza (ni descarta el payload completo) cuando metadata.phone_call llega como null explícito, no ausente — el caso real del widget web que rompió en producción', () => {
            // ElevenLabs manda `phone_call: null` en vez de omitir la clave
            // para llamadas sin tramo telefónico. El resto del código ya
            // maneja null vía optional chaining; el bug real estaba en el
            // schema Zod (`.optional()` rechaza null, solo permite undefined),
            // que descartaba TODO el payload antes de mapear ningún campo.
            const payload = buildPayload({
                phoneCall: null,
                dataCollectionResults: {
                    nombre_completo_prospecto: { value: 'Juana Pérez' },
                    telefono_contacto_prospecto: { value: '2221234567' },
                    correo_electronico_prospecto: { value: 'juana@example.com' },
                    motivo_consulta: { value: 'Cotización de instalación' },
                    cita_programada: { value: true },
                },
            });

            const mapped = mapElevenLabsPayload(payload);

            expect(mapped).not.toBeNull();
            expect(mapped!.hasPhoneCallLeg).toBe(false);
            expect(mapped!.fullName).toBe('Juana Pérez');
            // Sin tramo telefónico SIP, cae al teléfono dictado por voz.
            expect(mapped!.callerPhoneE164).toBe('+522221234567');
        });

        it('usa metadata.start_time_unix_secs para occurredAt cuando está presente', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.start_time_unix_secs = 1700000500;
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.occurredAt.getTime()).toBe(1700000500 * 1000);
        });

        it('usa event_timestamp del webhook cuando falta metadata.start_time_unix_secs', () => {
            const payload = buildPayload({}); // event_timestamp: 1700000000 (ver buildPayload)
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.occurredAt.getTime()).toBe(1700000000 * 1000);
        });

        it('recae en la hora de mapeo cuando ni start_time_unix_secs ni event_timestamp vienen en el payload', () => {
            const payload: any = buildPayload({});
            delete payload.event_timestamp;
            const before = Date.now();
            const mapped = mapElevenLabsPayload(payload);
            const after = Date.now();
            expect(mapped!.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
            expect(mapped!.occurredAt.getTime()).toBeLessThanOrEqual(after);
        });
    });

    /**
     * URGENTE: discriminador de canal de texto (WhatsApp) para el metering de
     * Fase 3 — `metadata.conversation_initiation_source === 'whatsapp'` o
     * `metadata.text_only === true` (docs oficiales de ElevenLabs, verificado
     * contra https://elevenlabs.io/docs/api-reference/conversations/get, no
     * asumido). `usage-registration.test.ts` cubre que este flag efectivamente
     * suprime `agent_minute`; aquí se cubre solo el mapeo del payload crudo.
     */
    describe('isTextChannel / whatsappMessageQuantity (metering de canales de texto)', () => {
        it('marca isTextChannel=true cuando conversation_initiation_source es "whatsapp"', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.conversation_initiation_source = 'whatsapp';
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.isTextChannel).toBe(true);
        });

        it('marca isTextChannel=true cuando text_only es true, aunque conversation_initiation_source no sea "whatsapp"', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.text_only = true;
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.isTextChannel).toBe(true);
        });

        it('contraparte de éxito: isTextChannel=false para una llamada de voz normal (ninguno de los dos campos presente)', () => {
            const payload = buildPayload({ phoneCall: { external_number: '+522231234567' } });
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.isTextChannel).toBe(false);
        });

        it('extrae whatsappMessageQuantity de metadata.platform_usage.category_usage.text_message.quantity', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.conversation_initiation_source = 'whatsapp';
            payload.data.metadata.platform_usage = {
                category_usage: {
                    text_message: { quantity: 5, price: 0.015, credits: 5 },
                },
            };
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.whatsappMessageQuantity).toBe(5);
        });

        it('contraparte de éxito: whatsappMessageQuantity queda null cuando el payload no trae platform_usage (nunca se inventa una cantidad)', () => {
            const payload = buildPayload({});
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.whatsappMessageQuantity).toBeNull();
        });

        // Casos límite: cada nivel de encadenamiento opcional
        // (metadata?.platform_usage?.category_usage?.text_message?.quantity)
        // debe tolerar que CUALQUIER nivel intermedio esté ausente (undefined,
        // no solo "objeto vacío") sin lanzar — de lo contrario un payload real
        // de ElevenLabs con un desglose parcial de platform_usage tumbaría
        // todo el job de process-call-completed en vez de solo dejar
        // whatsappMessageQuantity en null.
        it('no lanza cuando falta metadata por completo (payload atípico, pero no debe romper el mapeo)', () => {
            const payload: any = buildPayload({});
            delete payload.data.metadata;
            let mapped: ReturnType<typeof mapElevenLabsPayload>;
            expect(() => {
                mapped = mapElevenLabsPayload(payload);
            }).not.toThrow();
            expect(mapped!.isTextChannel).toBe(false);
            expect(mapped!.whatsappMessageQuantity).toBeNull();
        });

        it('no lanza cuando platform_usage está vacío, sin category_usage', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.platform_usage = {};
            let mapped: ReturnType<typeof mapElevenLabsPayload>;
            expect(() => {
                mapped = mapElevenLabsPayload(payload);
            }).not.toThrow();
            expect(mapped!.whatsappMessageQuantity).toBeNull();
        });

        it('no lanza cuando category_usage está vacío, sin la clave text_message', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.platform_usage = { category_usage: {} };
            let mapped: ReturnType<typeof mapElevenLabsPayload>;
            expect(() => {
                mapped = mapElevenLabsPayload(payload);
            }).not.toThrow();
            expect(mapped!.whatsappMessageQuantity).toBeNull();
        });

        it('no lanza cuando text_message existe pero sin quantity', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.platform_usage = { category_usage: { text_message: {} } };
            let mapped: ReturnType<typeof mapElevenLabsPayload>;
            expect(() => {
                mapped = mapElevenLabsPayload(payload);
            }).not.toThrow();
            expect(mapped!.whatsappMessageQuantity).toBeNull();
        });

        it('isTextChannel=false (no true) cuando conversation_initiation_source es "whatsapp" PERO text_only es false explícito — ambas condiciones se evalúan con OR, no se exige que las dos sean verdaderas', () => {
            // Distingue el operador || del && real del código: si fuera &&,
            // este caso (solo una de las dos condiciones en true) daría false.
            const payload: any = buildPayload({});
            payload.data.metadata.conversation_initiation_source = 'whatsapp';
            payload.data.metadata.text_only = false;
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.isTextChannel).toBe(true);
        });
    });

    /**
     * `channel` — antes de este fix, process_call_completed escribía 'voice'
     * a fuego para TODO lead. Verificado contra un caso real de producción
     * (conv_6201kzkmwnd8e658dn4c8fqg1c0d, una conversación de WhatsApp) que
     * había quedado guardada con channel='voice' estando mal.
     */
    describe('channel (derivado de conversation_initiation_source, LEAD_CHANNELS — nunca literales)', () => {
        it('conversation_initiation_source="whatsapp" → channel="whatsapp"', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.conversation_initiation_source = 'whatsapp';
            payload.data.metadata.text_only = true;
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.channel).toBe('whatsapp');
        });

        it('conversation_initiation_source="twilio_sms" → channel="sms"', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.conversation_initiation_source = 'twilio_sms';
            payload.data.metadata.text_only = true;
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.channel).toBe('sms');
        });

        it('canal de texto que no es whatsapp ni twilio_sms (text_only=true con otro source) → channel="web"', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.conversation_initiation_source = 'js_sdk';
            payload.data.metadata.text_only = true;
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.channel).toBe('web');
        });

        it('contraparte de éxito: una llamada de voz normal (sip_trunk, sin text_only) → channel="voice"', () => {
            const payload: any = buildPayload({ phoneCall: { external_number: '+522231234567' } });
            payload.data.metadata.conversation_initiation_source = 'sip_trunk';
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.channel).toBe('voice');
        });

        it('sin conversation_initiation_source en absoluto (payload atípico) → cae a "voice", no lanza', () => {
            const payload = buildPayload({});
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.channel).toBe('voice');
        });
    });

    /**
     * Tokens de LLM (`metadata.charging.llm_usage`) — cierra el hueco del 14%
     * de la factura. Estructura y valores de ejemplo tomados de payloads
     * reales de producción (webhook_events, provider='elevenlabs'), no
     * inventados.
     */
    describe('llmTokenUsage (metadata.charging.llm_usage.irreversible_generation.model_usage)', () => {
        it('extrae input/output tokens por modelo desde irreversible_generation', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.charging = {
                llm_usage: {
                    irreversible_generation: {
                        model_usage: {
                            'gemini-2.5-flash': {
                                input: { price: 0.00146025, tokens: 9735 },
                                output_total: { price: 0.0000168, tokens: 28 },
                            },
                        },
                    },
                },
            };
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.llmTokenUsage).toEqual([{ model: 'gemini-2.5-flash', inputTokens: 9735, outputTokens: 28 }]);
        });

        it('usa irreversible_generation, NUNCA initiated_generation (contaría reintentos dos veces) — valores reales de producción donde ambos difieren', () => {
            // Caso real (conv_3401kzh9m209evzt9qfy4a0emnh0): initiated_generation
            // trae más tokens que irreversible_generation porque incluye un
            // reintento del LLM que no llegó a facturarse.
            const payload: any = buildPayload({});
            payload.data.metadata.charging = {
                llm_usage: {
                    initiated_generation: {
                        model_usage: {
                            'gemini-2.5-flash': {
                                input: { price: 0.00205215, tokens: 13681 },
                                output_total: { price: 0.00016199999999999998, tokens: 270 },
                            },
                        },
                    },
                    irreversible_generation: {
                        model_usage: {
                            'gemini-2.5-flash': {
                                input: { price: 0.00138165, tokens: 9211 },
                                output_total: { price: 0.0001188, tokens: 198 },
                            },
                        },
                    },
                },
            };
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.llmTokenUsage).toEqual([{ model: 'gemini-2.5-flash', inputTokens: 9211, outputTokens: 198 }]);
        });

        it('varios modelos en la misma conversación producen una entrada por modelo', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.charging = {
                llm_usage: {
                    irreversible_generation: {
                        model_usage: {
                            'gpt-4o': { input: { tokens: 9002 }, output_total: { tokens: 28 } },
                            'gemini-2.5-flash': { input: { tokens: 42657 }, output_total: { tokens: 319 } },
                        },
                    },
                },
            };
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.llmTokenUsage).toHaveLength(2);
            const byModel = Object.fromEntries(mapped!.llmTokenUsage.map((u) => [u.model, u]));
            expect(byModel['gpt-4o']).toEqual({ model: 'gpt-4o', inputTokens: 9002, outputTokens: 28 });
            expect(byModel['gemini-2.5-flash']).toEqual({ model: 'gemini-2.5-flash', inputTokens: 42657, outputTokens: 319 });
        });

        it('contraparte de rechazo: sin metadata.charging en absoluto, llmTokenUsage queda vacío — no lanza, no inventa consumo', () => {
            const payload = buildPayload({});
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.llmTokenUsage).toEqual([]);
        });

        // Casos límite: cada nivel de charging?.llm_usage?.irreversible_generation?.model_usage
        // debe tolerar que CUALQUIER nivel intermedio esté presente pero vacío
        // (no solo "toda la rama ausente" del test anterior) sin lanzar.
        it('charging presente pero sin llm_usage no lanza: llmTokenUsage queda vacío', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.charging = {};
            let mapped: ReturnType<typeof mapElevenLabsPayload>;
            expect(() => {
                mapped = mapElevenLabsPayload(payload);
            }).not.toThrow();
            expect(mapped!.llmTokenUsage).toEqual([]);
        });

        it('llm_usage presente pero sin irreversible_generation no lanza (solo initiated_generation, que no se usa): llmTokenUsage queda vacío', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.charging = {
                llm_usage: {
                    initiated_generation: { model_usage: { 'gemini-2.5-flash': { input: { tokens: 999 } } } },
                },
            };
            let mapped: ReturnType<typeof mapElevenLabsPayload>;
            expect(() => {
                mapped = mapElevenLabsPayload(payload);
            }).not.toThrow();
            expect(mapped!.llmTokenUsage).toEqual([]);
        });

        it('irreversible_generation presente pero sin model_usage no lanza: llmTokenUsage queda vacío', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.charging = { llm_usage: { irreversible_generation: {} } };
            let mapped: ReturnType<typeof mapElevenLabsPayload>;
            expect(() => {
                mapped = mapElevenLabsPayload(payload);
            }).not.toThrow();
            expect(mapped!.llmTokenUsage).toEqual([]);
        });

        it('un modelo sin output_total (solo input) no lanza: outputTokens queda en 0, no se omite el modelo', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.charging = {
                llm_usage: {
                    irreversible_generation: {
                        model_usage: {
                            'gemini-2.5-flash': { input: { tokens: 500 } },
                        },
                    },
                },
            };
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.llmTokenUsage).toEqual([{ model: 'gemini-2.5-flash', inputTokens: 500, outputTokens: 0 }]);
        });

        it('un modelo sin input (solo output_total) no lanza: inputTokens queda en 0, no se omite el modelo', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.charging = {
                llm_usage: {
                    irreversible_generation: {
                        model_usage: {
                            'gemini-2.5-flash': { output_total: { tokens: 42 } },
                        },
                    },
                },
            };
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.llmTokenUsage).toEqual([{ model: 'gemini-2.5-flash', inputTokens: 0, outputTokens: 42 }]);
        });
    });

    /**
     * Continuidad cross-canal — caso real de producción:
     * conv_6201kzkmwnd8e658dn4c8fqg1c0d trae
     * metadata.whatsapp.whatsapp_user_id = '5212213528341' (sin '+', con el
     * "1" histórico de trunk móvil de México). Antes de este fix, el mapper
     * no leía ese campo en ningún lado — la llamada quedó con
     * callerPhoneE164=null y jamás se vinculó al contacto real
     * (+522213528341, ya existente por una llamada de voz previa de la misma
     * persona). El flujo completo contra la base real está en
     * __tests__/process-call-completed-rpc.test.ts.
     */
    describe('whatsapp_user_id en la resolución de teléfono (continuidad cross-canal)', () => {
        it('normaliza metadata.whatsapp.whatsapp_user_id al mismo E.164 que produciría una llamada de voz de la misma persona', () => {
            const payload: any = buildPayload({ phoneCall: null });
            payload.data.metadata.whatsapp = { whatsapp_user_id: '5212213528341', whatsapp_phone_number_id: '932565183274317' };
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.callerPhoneE164).toBe('+522213528341');
        });

        it('phone_call.external_number tiene prioridad sobre whatsapp_user_id si ambos vinieran presentes (dato inconsistente, pero telefonía real gana)', () => {
            const payload: any = buildPayload({ phoneCall: { external_number: '+522231234567' } });
            payload.data.metadata.whatsapp = { whatsapp_user_id: '5212213528341' };
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.callerPhoneE164).toBe('+522231234567');
        });

        it('contraparte de rechazo: whatsapp.whatsapp_user_id ausente (metadata.whatsapp=null, llamada de voz normal) no rompe la resolución de teléfono existente', () => {
            const payload: any = buildPayload({ phoneCall: { external_number: '+522231234567' } });
            payload.data.metadata.whatsapp = null;
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.callerPhoneE164).toBe('+522231234567');
        });

        it('un whatsapp_user_id inválido/no normalizable no lanza: callerPhoneE164 queda null', () => {
            const payload: any = buildPayload({ phoneCall: null });
            payload.data.metadata.whatsapp = { whatsapp_user_id: '123' };
            let mapped: ReturnType<typeof mapElevenLabsPayload>;
            expect(() => {
                mapped = mapElevenLabsPayload(payload);
            }).not.toThrow();
            expect(mapped!.callerPhoneE164).toBeNull();
        });
    });

    // -----------------------------------------------------------------
    // plan_de_interes y volumen_mensajes
    // -----------------------------------------------------------------
    describe('plan_de_interes y volumen_mensajes', () => {
        it('extrae plan_de_interes y volumen_mensajes cuando vienen en data_collection_results', () => {
            const payload = buildPayload({
                dataCollectionResults: {
                    plan_de_interes: { value: 'Plan Escala Ilimitado' },
                    volumen_mensajes: { value: '5000 al mes' },
                },
            });
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.planOfInterest).toBe('Plan Escala Ilimitado');
            expect(mapped!.messageVolume).toBe('5000 al mes');
        });

        it('devuelve null si plan_de_interes y volumen_mensajes no vienen en data_collection_results', () => {
            const payload = buildPayload({ dataCollectionResults: {} });
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.planOfInterest).toBeNull();
            expect(mapped!.messageVolume).toBeNull();
        });
    });

    // -----------------------------------------------------------------
    // source / sourceDetail (origen_prospecto y como_se_entero)
    // -----------------------------------------------------------------
    describe('source / sourceDetail — atribución de origen (origen_prospecto)', () => {
        it('mapea correctamente los valores del enum configurado en ElevenLabs a los valores del CHECK constraint', () => {
            const mappings: Array<[string, string]> = [
                ['referido', 'referido'],
                ['web', 'sitio_web'],
                ['facebook', 'redes_sociales'],
                ['instagram', 'redes_sociales'],
                ['tiktok', 'redes_sociales'],
                ['llamada', 'otro'],
                ['otro', 'otro'],
            ];

            for (const [inputEnum, expectedSource] of mappings) {
                const payload = buildPayload({ dataCollectionResults: { origen_prospecto: { value: inputEnum } } });
                const mapped = mapElevenLabsPayload(payload);
                expect(mapped!.source).toBe(expectedSource);
                expect(mapped!.sourceDetail).toBe(inputEnum);
            }
        });

        it('un valor exacto de LEAD_SOURCES se mapea tal cual desde origen_prospecto', () => {
            const payload = buildPayload({ dataCollectionResults: { origen_prospecto: { value: 'anuncio_pagado' } } });
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.source).toBe('anuncio_pagado');
            expect(mapped!.sourceDetail).toBe('anuncio_pagado');
        });

        it('soporta compatibilidad retroactiva con como_se_entero si origen_prospecto no viene', () => {
            const payload = buildPayload({ dataCollectionResults: { como_se_entero: { value: 'Referido' } } });
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.source).toBe('referido');
            expect(mapped!.sourceDetail).toBe('Referido');
        });

        it('un texto que NO encaja en ninguna categoría produce "desconocido", conservando el texto crudo en sourceDetail', () => {
            const payload = buildPayload({
                dataCollectionResults: { origen_prospecto: { value: 'me lo dijo un pajarito, no recuerdo bien' } },
            });
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.source).toBe('desconocido');
            expect(mapped!.sourceDetail).toBe('me lo dijo un pajarito, no recuerdo bien');
        });

        it('contraparte: campo ausente en data_collection_results → source y sourceDetail quedan null (no "desconocido")', () => {
            const payload = buildPayload({ dataCollectionResults: { motivo_consulta: { value: 'Otra cosa' } } });
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.source).toBeNull();
            expect(mapped!.sourceDetail).toBeNull();
        });
    });

    // -----------------------------------------------------------------
    // sentiment (extracción robusta de sentimiento polimórfico)
    // -----------------------------------------------------------------
    describe('sentiment (análisis de sentimiento de llamada)', () => {
        it('mapea call_successful: true a sentiment: "Positivo"', () => {
            const payload: any = buildPayload({});
            payload.data.analysis.call_successful = true;
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.sentiment).toBe('Positivo');
        });

        it('mapea call_successful: "success" a sentiment: "Positivo"', () => {
            const payload: any = buildPayload({});
            payload.data.analysis.call_successful = 'success';
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.sentiment).toBe('Positivo');
        });

        it('mapea call_successful: false a sentiment: "Negativo"', () => {
            const payload: any = buildPayload({});
            payload.data.analysis.call_successful = false;
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.sentiment).toBe('Negativo');
        });

        it('mapea call_successful: "failure" a sentiment: "Negativo"', () => {
            const payload: any = buildPayload({});
            payload.data.analysis.call_successful = 'failure';
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.sentiment).toBe('Negativo');
        });

        it('cuando call_successful es unknown, usa evaluation_criteria_results', () => {
            const payload: any = buildPayload({});
            payload.data.analysis.call_successful = 'unknown';
            payload.data.analysis.evaluation_criteria_results = {
                criterio: { result: 'success' },
            };
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.sentiment).toBe('Positivo');
        });

        it('fallback inteligente: sin call_successful pero con duración >20s y >=2 turnos → "Positivo"', () => {
            const payload = buildPayload({
                transcript: [
                    { role: 'agent', message: 'Hola' },
                    { role: 'user', message: 'Cotización' },
                ],
            });
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.sentiment).toBe('Positivo');
        });
    });
});

