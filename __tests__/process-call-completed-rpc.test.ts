import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { mapElevenLabsPayload } from '../src/services/call-payload-mapper.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

/**
 * Estas pruebas ejercitan el RPC `process_call_completed` definido en
 * db/migrations/03_process_call_completed.sql. Requieren que esa migración
 * ya esté aplicada en la base de datos de Supabase contra la que corre la
 * suite — si el RPC no existe todavía, fallarán con "function ... does not
 * exist" y eso es la señal correcta de que falta aplicar la migración.
 */
describe('2.2 — RPC process_call_completed', () => {
    const conversationId = `rpc-test-conv:${Date.now()}`;
    const phone = `+521650000${Math.floor(Math.random() * 9000 + 1000)}`;

    afterAll(async () => {
        await supabaseAdmin.from('leads').delete().eq('conversation_id', conversationId);
        await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', conversationId);
        await supabaseAdmin.from('contacts').delete().eq('phone_e164', phone);
    });

    function callRpc(overrides: Record<string, unknown> = {}) {
        return supabaseAdmin.rpc('process_call_completed', {
            p_organization_id: REAL_ORG_ID,
            p_conversation_id: conversationId,
            p_provider_call_id: conversationId,
            p_caller_phone_e164: phone,
            p_full_name: null,
            p_email: null,
            p_business_name: null,
            p_business_sector: null,
            p_contact_phone_raw: null,
            p_inquiry_reason: null,
            p_temperature: null,
            p_booked_appointment: false,
            p_needs_followup: false,
            p_followup_notes: null,
            p_call_volume: null,
            p_transcript: 'Cliente: Hola.\nAgente: ¿En qué te ayudo?',
            p_summary: 'Llamada sin datos capturados.',
            p_duration_seconds: 42,
            ...overrides,
        });
    }

    it('extracción vacía: crea un lead con campos vacíos, sin inventar datos', async () => {
        const { data, error } = await callRpc();
        expect(error).toBeNull();
        expect(data.lead_inserted).toBe(true);
        expect(data.lead_id).toBeTruthy();
        expect(data.contact_id).toBeTruthy();

        const { data: lead } = await supabaseAdmin
            .from('leads')
            .select('full_name, email, business_name, inquiry_reason, temperature')
            .eq('id', data.lead_id)
            .single();

        expect(lead?.full_name).toBeNull();
        expect(lead?.email).toBeNull();
        expect(lead?.business_name).toBeNull();
        expect(lead?.inquiry_reason).toBeNull();
        expect(lead?.temperature).toBeNull();
    });

    it('channel: sin p_channel explícito, cae al DEFAULT \'voice\' de la función (antes de este fix, era el ÚNICO valor posible, a fuego)', async () => {
        const { data } = await callRpc();
        const { data: lead } = await supabaseAdmin.from('leads').select('channel').eq('id', data.lead_id).single();
        expect(lead?.channel).toBe('voice');
    });

    it('contraparte de éxito: channel respeta el valor explícito que manda el llamador (p_channel)', async () => {
        const whatsappConversationId = `${conversationId}-channel-whatsapp`;
        const { data, error } = await callRpc({
            p_conversation_id: whatsappConversationId,
            p_provider_call_id: whatsappConversationId,
            p_channel: 'whatsapp',
        });
        expect(error).toBeNull();
        const { data: lead } = await supabaseAdmin.from('leads').select('channel').eq('id', data.lead_id).single();
        expect(lead?.channel).toBe('whatsapp');

        await supabaseAdmin.from('leads').delete().eq('conversation_id', whatsappConversationId);
        await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', whatsappConversationId);
    });

    it('idempotencia: el mismo conversation_id procesado dos veces no duplica el lead', async () => {
        const first = await callRpc();
        const second = await callRpc({ p_summary: 'Segundo intento (reintento del webhook)' });

        expect(first.error).toBeNull();
        expect(second.error).toBeNull();
        expect(second.data.lead_inserted).toBe(false);
        expect(second.data.lead_id).toBe(first.data.lead_id);

        const { data: leads } = await supabaseAdmin
            .from('leads')
            .select('id')
            .eq('organization_id', REAL_ORG_ID)
            .eq('conversation_id', conversationId);

        expect(leads?.length).toBe(1);
    });

    it('no sobrescribe un dato bueno del contacto con uno vacío en una llamada posterior', async () => {
        await callRpc({ p_full_name: 'Roberto Díaz' });

        const { data: contactAfterFirst } = await supabaseAdmin
            .from('contacts')
            .select('id, full_name')
            .eq('organization_id', REAL_ORG_ID)
            .eq('phone_e164', phone)
            .single();
        expect(contactAfterFirst?.full_name).toBe('Roberto Díaz');

        // Segunda llamada del mismo contacto, con nombre vacío (no debe borrar el nombre ya capturado).
        const secondConversationId = `${conversationId}-b`;
        await supabaseAdmin.rpc('process_call_completed', {
            p_organization_id: REAL_ORG_ID,
            p_conversation_id: secondConversationId,
            p_provider_call_id: secondConversationId,
            p_caller_phone_e164: phone,
            p_full_name: null,
            p_email: null,
            p_business_name: null,
            p_business_sector: null,
            p_contact_phone_raw: null,
            p_inquiry_reason: null,
            p_temperature: null,
            p_booked_appointment: false,
            p_needs_followup: false,
            p_followup_notes: null,
            p_call_volume: null,
            p_transcript: '',
            p_summary: '',
            p_duration_seconds: 0,
        });

        const { data: contactAfterSecond } = await supabaseAdmin
            .from('contacts')
            .select('full_name')
            .eq('organization_id', REAL_ORG_ID)
            .eq('phone_e164', phone)
            .single();
        expect(contactAfterSecond?.full_name).toBe('Roberto Díaz');

        await supabaseAdmin.from('leads').delete().eq('conversation_id', secondConversationId);
        await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', secondConversationId);
    });

    it('fusiona la siembra de formulario (llamada outbound) con el webhook real: temperature/booked_appointment se actualizan, full_name/email del formulario no se pisan con lo dictado por voz (docs/tasks/outbound-lead-persistence-and-rate-limit.md, migración 13)', async () => {
        const mergeConversationId = `${conversationId}-merge`;
        const mergePhone = `+521650002${Math.floor(Math.random() * 9000 + 1000)}`;

        // 1. Siembra inmediata (voice.ts, en cuanto ElevenLabs confirma el
        //    conversation_id): solo datos confiables del formulario, sin
        //    temperature/booked_appointment (el agente aún no ha hablado).
        const seed = await callRpc({
            p_conversation_id: mergeConversationId,
            p_provider_call_id: mergeConversationId,
            p_caller_phone_e164: mergePhone,
            p_full_name: 'Roberto Díaz',
            p_email: 'roberto@example.com',
            p_inquiry_reason: 'Probar agente de voz en vivo',
            p_transcript: null,
            p_summary: null,
            p_duration_seconds: 0,
        });
        expect(seed.error).toBeNull();
        expect(seed.data.lead_inserted).toBe(true);

        // 2. Webhook real, minutos después: mismo conversation_id, ahora con
        //    temperature/booked_appointment capturados en vivo, y un
        //    full_name distinto (dictado por voz — menos confiable que el
        //    formulario, no debe pisar el ya capturado).
        const webhook = await callRpc({
            p_conversation_id: mergeConversationId,
            p_provider_call_id: mergeConversationId,
            p_caller_phone_e164: mergePhone,
            p_full_name: 'Nombre Mal Entendido Por Voz',
            p_temperature: 'caliente',
            p_booked_appointment: true,
            p_transcript: 'Cliente: Hola.\nAgente: ¿En qué te ayudo?',
            p_summary: 'Llamada completada.',
            p_duration_seconds: 95,
        });
        expect(webhook.error).toBeNull();
        expect(webhook.data.lead_inserted).toBe(false);
        expect(webhook.data.lead_id).toBe(seed.data.lead_id);

        const { data: lead } = await supabaseAdmin
            .from('leads')
            .select('full_name, email, temperature, booked_appointment')
            .eq('id', seed.data.lead_id)
            .single();

        // temperature/booked_appointment: el webhook sí los actualiza (NULL/false en la siembra).
        expect(lead?.temperature).toBe('caliente');
        expect(lead?.booked_appointment).toBe(true);
        // full_name/email: los del formulario no se pisan con lo dictado por voz.
        expect(lead?.full_name).toBe('Roberto Díaz');
        expect(lead?.email).toBe('roberto@example.com');

        await supabaseAdmin.from('leads').delete().eq('conversation_id', mergeConversationId);
        await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', mergeConversationId);
        await supabaseAdmin.from('contacts').delete().eq('phone_e164', mergePhone);
    });

    it('normalización E.164: un teléfono no normalizable (null) no aborta el procesamiento — el lead se crea sin contact_id', async () => {
        const noPhoneConversationId = `${conversationId}-no-phone`;
        const { data, error } = await supabaseAdmin.rpc('process_call_completed', {
            p_organization_id: REAL_ORG_ID,
            p_conversation_id: noPhoneConversationId,
            p_provider_call_id: noPhoneConversationId,
            p_caller_phone_e164: null,
            p_full_name: 'Prospecto Del Widget Web',
            p_email: null,
            p_business_name: null,
            p_business_sector: null,
            p_contact_phone_raw: 'número inválido, sin normalizar',
            p_inquiry_reason: null,
            p_temperature: null,
            p_booked_appointment: false,
            p_needs_followup: false,
            p_followup_notes: null,
            p_call_volume: null,
            p_transcript: 'Cliente: Hola, escribo desde el widget.\nAgente: Claro, cuéntame.',
            p_summary: 'Prospecto de widget web sin teléfono normalizable.',
            p_duration_seconds: 30,
        });

        expect(error).toBeNull();
        expect(data.lead_inserted).toBe(true);
        expect(data.lead_id).toBeTruthy();
        expect(data.contact_id).toBeNull();

        const { data: lead } = await supabaseAdmin
            .from('leads')
            .select('full_name')
            .eq('id', data.lead_id)
            .single();
        expect(lead?.full_name).toBe('Prospecto Del Widget Web');

        await supabaseAdmin.from('leads').delete().eq('conversation_id', noPhoneConversationId);
        await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', noPhoneConversationId);
    });

    /**
     * Fase B (docs/tasks/opus.md) — antes de delegar en resolve_contact(),
     * esta rama solo resolvía contact_id si había teléfono; un widget web
     * que solo captura correo (sin caller ID) nunca vinculaba contacto,
     * aunque hubiera identidad suficiente. Contraparte directa del test de
     * arriba (null/null → sin contacto): aquí solo el correo SÍ debe
     * resolver/crear uno.
     */
    it('widget web sin teléfono, solo correo: SÍ resuelve/crea contact_id (contraparte del caso anterior)', async () => {
        const emailOnlyConversationId = `${conversationId}-email-only`;
        const widgetEmail = `widget-sin-telefono-${Date.now()}@example.invalid`;
        const { data, error } = await supabaseAdmin.rpc('process_call_completed', {
            p_organization_id: REAL_ORG_ID,
            p_conversation_id: emailOnlyConversationId,
            p_provider_call_id: emailOnlyConversationId,
            p_caller_phone_e164: null,
            p_full_name: 'Prospecto Del Widget Web',
            p_email: widgetEmail,
            p_business_name: null,
            p_business_sector: null,
            p_contact_phone_raw: null,
            p_inquiry_reason: null,
            p_temperature: null,
            p_booked_appointment: false,
            p_needs_followup: false,
            p_followup_notes: null,
            p_call_volume: null,
            p_transcript: 'Cliente: Hola, escribo desde el widget, mi correo es ...',
            p_summary: 'Prospecto de widget web, solo correo.',
            p_duration_seconds: 30,
        });

        expect(error).toBeNull();
        expect(data.contact_id).toBeTruthy();

        const { data: contact } = await supabaseAdmin.from('contacts').select('id, email, phone_e164').eq('id', data.contact_id).single();
        expect(contact?.email).toBe(widgetEmail);
        expect(contact?.phone_e164).toBeNull();

        await supabaseAdmin.from('leads').delete().eq('conversation_id', emailOnlyConversationId);
        await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', emailOnlyConversationId);
        await supabaseAdmin.from('contacts').delete().eq('id', data.contact_id);
    });

    /**
     * Migración 19 — dirección de servicio del prospecto y coordenadas
     * geocodificadas. El RPC solo persiste lo que recibe (la geocodificación
     * real vía Google Maps ocurre antes, en jobs/process-call-completed.ts —
     * ver __tests__/geocoding.test.ts); aquí se verifica que call_logs
     * guarda los 6 campos nuevos y que un reintento con esos campos vacíos
     * no borra un dato ya bueno (mismo patrón COALESCE que customer_name).
     */
    it('persiste customer_address/city/state/zip/lat/lng en call_logs', async () => {
        const addressConversationId = `${conversationId}-address`;
        const { data, error } = await callRpc({
            p_conversation_id: addressConversationId,
            p_provider_call_id: addressConversationId,
            p_customer_address: 'Calle Reforma 123',
            p_customer_city: 'Puebla',
            p_customer_state: 'Puebla',
            p_customer_zip: '72000',
            p_customer_lat: 19.0433,
            p_customer_lng: -98.1982,
        });
        expect(error).toBeNull();

        const { data: callLog } = await supabaseAdmin
            .from('call_logs')
            .select('customer_address, customer_city, customer_state, customer_zip, customer_lat, customer_lng')
            .eq('id', data.call_log_id)
            .single();

        expect(callLog?.customer_address).toBe('Calle Reforma 123');
        expect(callLog?.customer_city).toBe('Puebla');
        expect(callLog?.customer_state).toBe('Puebla');
        expect(callLog?.customer_zip).toBe('72000');
        expect(Number(callLog?.customer_lat)).toBeCloseTo(19.0433, 4);
        expect(Number(callLog?.customer_lng)).toBeCloseTo(-98.1982, 4);

        await supabaseAdmin.from('leads').delete().eq('conversation_id', addressConversationId);
        await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', addressConversationId);
    });

    it('contraparte de éxito: sin los parámetros de dirección (DEFAULT NULL), call_logs no falla y queda con esos campos en null', async () => {
        const noAddressConversationId = `${conversationId}-no-address`;
        const { data, error } = await callRpc({
            p_conversation_id: noAddressConversationId,
            p_provider_call_id: noAddressConversationId,
        });
        expect(error).toBeNull();

        const { data: callLog } = await supabaseAdmin
            .from('call_logs')
            .select('customer_address, customer_lat, customer_lng')
            .eq('id', data.call_log_id)
            .single();

        expect(callLog?.customer_address).toBeNull();
        expect(callLog?.customer_lat).toBeNull();
        expect(callLog?.customer_lng).toBeNull();

        await supabaseAdmin.from('leads').delete().eq('conversation_id', noAddressConversationId);
        await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', noAddressConversationId);
    });

    it('no sobrescribe una dirección ya buena de call_logs con una vacía en un reintento (mismo patrón COALESCE que customer_name)', async () => {
        const retryConversationId = `${conversationId}-address-retry`;
        const first = await callRpc({
            p_conversation_id: retryConversationId,
            p_provider_call_id: retryConversationId,
            p_customer_address: 'Calle Reforma 123',
            p_customer_city: 'Puebla',
        });
        expect(first.error).toBeNull();

        const second = await callRpc({
            p_conversation_id: retryConversationId,
            p_provider_call_id: retryConversationId,
            p_summary: 'Reintento del webhook sin dirección',
        });
        expect(second.error).toBeNull();

        const { data: callLog } = await supabaseAdmin
            .from('call_logs')
            .select('customer_address, customer_city')
            .eq('id', first.data.call_log_id)
            .single();

        expect(callLog?.customer_address).toBe('Calle Reforma 123');
        expect(callLog?.customer_city).toBe('Puebla');

        await supabaseAdmin.from('leads').delete().eq('conversation_id', retryConversationId);
        await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', retryConversationId);
    });
});

/**
 * Fase 3 — Metering. Ejercita la extensión de `process_call_completed` hecha
 * en `db/migrations/05_process_call_completed_usage.sql`: inserción de
 * `usage_events` en la misma transacción, con idempotencia vía
 * `idempotency_key` (UNIQUE) + ON CONFLICT DO NOTHING.
 *
 * `usage_events` es append-only (trigger `trg_usage_no_update` bloquea
 * UPDATE/DELETE) y su CHECK constraint exige `quantity >= 0` — una
 * "corrección" con cantidad negativa (como sugiere el patrón general de
 * asientos compensatorios) no es posible sobre el `quantity` en sí, solo
 * sobre `unit_rate_usd`. Por eso, igual que
 * __tests__/usage-event-provider.test.ts, este test usa `unit_type`
 * diagnósticos únicos por ejecución en vez de los reales
 * ('agent_minute'/'sip_inbound_local_mx'): quedan aislados de cualquier otra
 * corrida sin necesitar limpieza, y no se atribuyen por error a un
 * unit_type de negocio real.
 */
describe('3.2 — RPC process_call_completed: registro de consumo (usage_events)', () => {
    const runId = Date.now();
    const conversationId = `rpc-usage-test-conv:${runId}`;
    const phone = `+521650001${Math.floor(Math.random() * 900 + 100)}`;
    const occurredAtIso = '2026-08-15T00:00:00.000Z';
    const diagAgentUnit = `diag_rpc_agent_minute_${runId}`;
    const diagTelnyxUnit = `diag_rpc_sip_inbound_${runId}`;

    const usageEntries = [
        {
            provider: 'elevenlabs',
            unit_type: diagAgentUnit,
            quantity: 200 / 60,
            unit_rate_usd: 0.08,
            occurred_at: occurredAtIso,
            idempotency_key: `${conversationId}:elevenlabs:${diagAgentUnit}`,
        },
        {
            provider: 'telnyx',
            unit_type: diagTelnyxUnit,
            quantity: 200 / 60,
            unit_rate_usd: 0.005,
            occurred_at: occurredAtIso,
            idempotency_key: `${conversationId}:telnyx:${diagTelnyxUnit}`,
        },
    ];

    afterAll(async () => {
        await supabaseAdmin.from('leads').delete().eq('conversation_id', conversationId);
        await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', conversationId);
        await supabaseAdmin.from('contacts').delete().eq('phone_e164', phone);
        // Las filas de usage_events (unit_type diagnóstico, aislado por
        // runId) se dejan permanentes a propósito: no se pueden borrar
        // (append-only) y al no compartir unit_type con ninguna corrida ni
        // con datos reales, no requieren limpieza.
    });

    function callRpcWithUsage(overrides: Record<string, unknown> = {}) {
        return supabaseAdmin.rpc('process_call_completed', {
            p_organization_id: REAL_ORG_ID,
            p_conversation_id: conversationId,
            p_provider_call_id: conversationId,
            p_caller_phone_e164: phone,
            p_full_name: null,
            p_email: null,
            p_business_name: null,
            p_business_sector: null,
            p_contact_phone_raw: null,
            p_inquiry_reason: null,
            p_temperature: null,
            p_booked_appointment: false,
            p_needs_followup: false,
            p_followup_notes: null,
            p_call_volume: null,
            p_transcript: 'Cliente: Hola.\nAgente: ¿En qué te ayudo?',
            p_summary: 'Llamada con metering.',
            p_duration_seconds: 200,
            p_usage_entries: usageEntries,
            ...overrides,
        });
    }

    it('inserta los asientos de usage_events en la misma transacción que el lead', async () => {
        const { data, error } = await callRpcWithUsage();
        expect(error).toBeNull();
        expect(data.usage_events_inserted).toBe(2);

        const { data: rows } = await supabaseAdmin
            .from('usage_events')
            .select('provider, unit_type, quantity, unit_rate_usd, amount_usd, call_log_id')
            .eq('conversation_id', conversationId)
            .gt('quantity', 0);

        expect(rows).toHaveLength(2);
        const byUnitType = Object.fromEntries((rows ?? []).map((r) => [r.unit_type, r]));
        expect(byUnitType[diagAgentUnit].call_log_id).toBe(data.call_log_id);
        expect(Number(byUnitType[diagAgentUnit].amount_usd)).toBeCloseTo((200 / 60) * 0.08, 5);
    });

    it('idempotencia: el mismo conversation_id reintentado no duplica los asientos de usage_events', async () => {
        const second = await callRpcWithUsage({ p_summary: 'Reintento del webhook (mismo conversation_id)' });
        expect(second.error).toBeNull();
        // ON CONFLICT (idempotency_key) DO NOTHING: la segunda llamada no inserta nada nuevo.
        expect(second.data.usage_events_inserted).toBe(0);

        const { data: rows } = await supabaseAdmin
            .from('usage_events')
            .select('id')
            .eq('conversation_id', conversationId)
            .gt('quantity', 0);

        expect(rows).toHaveLength(2);
    });
});

describe('3.2 — usage_events es append-only (trigger trg_usage_no_update)', () => {
    // unit_type diagnóstico único por ejecución: el CHECK constraint
    // quantity >= 0 impide "revertir" estas filas con cantidad negativa, así
    // que quedan permanentes (igual que __tests__/usage-event-provider.test.ts)
    // en vez de intentar una limpieza que fallaría silenciosamente.
    const diagUnit = `diag_append_only_${Date.now()}`;
    let insertedId: string;

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('usage_events')
            .insert({
                organization_id: REAL_ORG_ID,
                provider: 'elevenlabs',
                unit_type: diagUnit,
                quantity: 1,
                unit_rate_usd: 0.08,
                metadata: { diagnostic: 'process-call-completed-rpc.test.ts append-only' },
            })
            .select('id')
            .single();

        if (error || !data) {
            throw new Error(`No se pudo insertar la fila de prueba: ${error?.message}`);
        }
        insertedId = data.id;
    });

    it('un UPDATE sobre una fila existente de usage_events falla (bloqueado por el trigger)', async () => {
        const { error } = await supabaseAdmin
            .from('usage_events')
            .update({ quantity: 999 })
            .eq('id', insertedId);

        expect(error).not.toBeNull();
    });

    it('un DELETE sobre una fila existente de usage_events también falla (mismo trigger, BEFORE DELETE OR UPDATE)', async () => {
        const { error } = await supabaseAdmin
            .from('usage_events')
            .delete()
            .eq('id', insertedId);

        expect(error).not.toBeNull();
    });

    it('contraparte de éxito: un INSERT nuevo (asiento compensatorio) sí se acepta sin error', async () => {
        const { error } = await supabaseAdmin.from('usage_events').insert({
            organization_id: REAL_ORG_ID,
            provider: 'elevenlabs',
            unit_type: diagUnit,
            quantity: 0.5,
            unit_rate_usd: 0.08,
            metadata: { diagnostic: 'process-call-completed-rpc.test.ts append-only (insert de control)' },
        });
        expect(error).toBeNull();
    });
});

/**
 * Continuidad cross-canal — caso real de producción encontrado al
 * investigar esta tarea: el webhook conv_6201kzkmwnd8e658dn4c8fqg1c0d
 * (organización real, provider='elevenlabs') es una conversación de
 * WhatsApp cuyo `metadata.whatsapp.whatsapp_user_id` llega como
 * '5212213528341' (sin '+', con el "1" histórico de trunk móvil de México).
 * Antes de este fix, ese campo no se leía en ningún lado: el lead quedó con
 * `contact_id: null`, `channel: 'voice'` (verificado por consulta directa
 * antes de escribir este test) — completamente desvinculado del contacto
 * real +522213528341, que YA existe en la base por una llamada de voz previa
 * de la misma persona (Víctor Mancera Gallardo, conv_8801kzhkm2dyezdah57enffbvwjx).
 *
 * Este test no reprocesa el evento real (no lo toca): construye un payload
 * nuevo con la misma forma real (mismo whatsapp_user_id, mismo formato) bajo
 * un conversation_id de prueba desechable, y verifica contra el CONTACTO
 * REAL ya existente — no contra un fixture — que ambos quedan vinculados al
 * mismo contact_id.
 */
describe('Continuidad cross-canal — WhatsApp (whatsapp_user_id) vs. voz previa, mismo contacto', () => {
    const EXISTING_CONTACT_PHONE = '+522213528341'; // Víctor Mancera Gallardo — contacto real, no se toca ni se borra.
    const whatsappConversationId = `test-cross-channel-whatsapp:${Date.now()}`;

    afterAll(async () => {
        await supabaseAdmin.from('leads').delete().eq('conversation_id', whatsappConversationId);
        await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', whatsappConversationId);
        // No se borra el contacto +522213528341: es un contacto real
        // preexistente de producción, no un fixture de esta prueba.
    });

    it('un webhook de WhatsApp con whatsapp_user_id="5212213528341" se vincula al MISMO contact_id que la llamada de voz previa de +522213528341', async () => {
        const { data: existingContact, error: contactError } = await supabaseAdmin
            .from('contacts')
            .select('id')
            .eq('organization_id', REAL_ORG_ID)
            .eq('phone_e164', EXISTING_CONTACT_PHONE)
            .maybeSingle();

        let contactId = existingContact?.id;
        if (!contactId) {
            const { data: createdContact, error: createErr } = await supabaseAdmin
                .from('contacts')
                .upsert({
                    organization_id: REAL_ORG_ID,
                    phone_e164: EXISTING_CONTACT_PHONE,
                    first_name: 'Contacto',
                    last_name: 'Prueba Continuidad',
                }, { onConflict: 'organization_id,phone_e164' })
                .select('id')
                .single();
            if (createErr || !createdContact) {
                throw new Error(`No se pudo autocrear el contacto de prueba ${EXISTING_CONTACT_PHONE}: ${createErr?.message}`);
            }
            contactId = createdContact.id;
        }

        const whatsappPayload = {
            type: 'post_call_transcription',
            event_timestamp: 1754750000,
            data: {
                agent_id: 'agent_0801kyr7h69hehdv6bgz7enntv9h',
                conversation_id: whatsappConversationId,
                transcript: [{ role: 'user', message: 'Hola, quiero información' }],
                analysis: { transcript_summary: 'Prospecto pregunta por información vía WhatsApp.' },
                metadata: {
                    call_duration_secs: 45,
                    conversation_initiation_source: 'whatsapp',
                    text_only: true,
                    phone_call: null,
                    whatsapp: {
                        direction: 'inbound',
                        whatsapp_user_id: '5212213528341',
                        whatsapp_phone_number_id: '932565183274317',
                    },
                },
            },
        };

        const mapped = mapElevenLabsPayload(whatsappPayload);
        expect(mapped).not.toBeNull();
        expect(mapped!.callerPhoneE164).toBe(EXISTING_CONTACT_PHONE);
        expect(mapped!.channel).toBe('whatsapp');

        const { data, error } = await supabaseAdmin.rpc('process_call_completed', {
            p_organization_id: REAL_ORG_ID,
            p_conversation_id: mapped!.conversationId,
            p_provider_call_id: mapped!.providerCallId,
            p_caller_phone_e164: mapped!.callerPhoneE164,
            p_full_name: mapped!.fullName,
            p_email: mapped!.email,
            p_business_name: mapped!.businessName,
            p_business_sector: mapped!.businessSector,
            p_contact_phone_raw: mapped!.contactPhoneRaw,
            p_inquiry_reason: mapped!.inquiryReason,
            p_temperature: mapped!.temperature,
            p_booked_appointment: mapped!.bookedAppointment,
            p_needs_followup: mapped!.needsFollowup,
            p_followup_notes: mapped!.followupNotes,
            p_call_volume: mapped!.callVolume,
            p_transcript: mapped!.transcript,
            p_summary: mapped!.summary,
            p_duration_seconds: mapped!.durationSeconds,
            p_usage_entries: [],
            p_channel: mapped!.channel,
        });

        expect(error).toBeNull();
        expect(data.contact_id).toBe(contactId);

        const { data: lead } = await supabaseAdmin
            .from('leads')
            .select('contact_id, channel, contact_phone')
            .eq('id', data.lead_id)
            .single();

        expect(lead?.contact_id).toBe(contactId);
        expect(lead?.channel).toBe('whatsapp');
        expect(lead?.contact_phone).toBe(EXISTING_CONTACT_PHONE);
    });
});

/**
 * Migración 21 — `call_logs.channel` y deduplicación de identidad de
 * contacto por correo cuando el teléfono no coincide (misma persona, dos
 * canales, dos teléfonos distintos capturados — ej. un número dictado por
 * voz mal transcrito vs. un whatsapp_user_id verificado).
 */
describe('Migración 21 — call_logs.channel y deduplicación de contacto por correo (fallback de teléfono)', () => {
    const conversationIdA = `test-migration-21-a:${Date.now()}`;
    const conversationIdB = `test-migration-21-b:${Date.now()}`;
    const phoneA = `+521650003${Math.floor(Math.random() * 900 + 100)}`;
    const phoneB = `+521650004${Math.floor(Math.random() * 900 + 100)}`;
    const sharedEmail = `dedupe-test-${Date.now()}@example.invalid`;

    afterAll(async () => {
        await supabaseAdmin.from('leads').delete().in('conversation_id', [conversationIdA, conversationIdB, `${conversationIdA}-c`]);
        await supabaseAdmin.from('call_logs').delete().in('provider_call_id', [conversationIdA, conversationIdB, `${conversationIdA}-c`]);
        await supabaseAdmin.from('contacts').delete().in('phone_e164', [phoneA, phoneB]);
    });

    function callRpc21(overrides: Record<string, unknown>) {
        return supabaseAdmin.rpc('process_call_completed', {
            p_organization_id: REAL_ORG_ID,
            p_full_name: null,
            p_email: null,
            p_business_name: null,
            p_business_sector: null,
            p_contact_phone_raw: null,
            p_inquiry_reason: null,
            p_temperature: null,
            p_booked_appointment: false,
            p_needs_followup: false,
            p_followup_notes: null,
            p_call_volume: null,
            p_transcript: '',
            p_summary: '',
            p_duration_seconds: 0,
            p_channel: 'voice',
            ...overrides,
        });
    }

    it('persiste `channel` en call_logs con el mismo valor que leads.channel', async () => {
        const { data, error } = await callRpc21({
            p_conversation_id: conversationIdA,
            p_provider_call_id: conversationIdA,
            p_caller_phone_e164: phoneA,
            p_full_name: 'Prospecto Canal Test',
            p_email: sharedEmail,
            p_transcript: 'Cliente: Hola por WhatsApp.',
            p_summary: 'Primer contacto por WhatsApp.',
            p_duration_seconds: 20,
            p_channel: 'whatsapp',
        });
        expect(error).toBeNull();

        const { data: callLog } = await supabaseAdmin.from('call_logs').select('channel').eq('id', data.call_log_id).single();
        expect(callLog?.channel).toBe('whatsapp');
    });

    it('una segunda conversación con TELÉFONO DISTINTO pero el MISMO correo se vincula al contacto existente — no crea un contacto fantasma', async () => {
        const { data: firstContact } = await supabaseAdmin
            .from('contacts')
            .select('id, phone_e164')
            .eq('organization_id', REAL_ORG_ID)
            .eq('phone_e164', phoneA)
            .single();
        expect(firstContact).not.toBeNull();

        const { data, error } = await callRpc21({
            p_conversation_id: conversationIdB,
            p_provider_call_id: conversationIdB,
            p_caller_phone_e164: phoneB, // teléfono DISTINTO al de la primera conversación
            p_full_name: 'Prospecto Canal Test',
            p_email: sharedEmail, // MISMO correo → debe resolver al mismo contacto
            p_transcript: 'Cliente: Hola, llamé antes por WhatsApp.',
            p_summary: 'Segundo contacto, ahora por voz, teléfono dictado distinto.',
            p_duration_seconds: 40,
        });

        expect(error).toBeNull();
        expect(data.contact_id).toBe(firstContact!.id); // mismo contacto, no uno nuevo

        const { data: ghostContact } = await supabaseAdmin
            .from('contacts')
            .select('id')
            .eq('organization_id', REAL_ORG_ID)
            .eq('phone_e164', phoneB)
            .maybeSingle();
        expect(ghostContact).toBeNull(); // nunca se creó un contacto fantasma con phoneB

        const { data: contactAfter } = await supabaseAdmin.from('contacts').select('phone_e164').eq('id', firstContact!.id).single();
        expect(contactAfter?.phone_e164).toBe(phoneA); // el teléfono original nunca se sobreescribe por la coincidencia de correo
    });

    it('contraparte de éxito: el teléfono tiene prioridad sobre el correo — un teléfono ya conocido resuelve al contacto correcto aunque el correo no coincida', async () => {
        const conversationIdC = `${conversationIdA}-c`;
        const { data, error } = await callRpc21({
            p_conversation_id: conversationIdC,
            p_provider_call_id: conversationIdC,
            p_caller_phone_e164: phoneA, // mismo teléfono que la primera conversación
            p_email: 'correo-diferente@example.invalid', // correo distinto, no debe importar
        });
        expect(error).toBeNull();

        const { data: contact } = await supabaseAdmin
            .from('contacts')
            .select('id, email')
            .eq('organization_id', REAL_ORG_ID)
            .eq('phone_e164', phoneA)
            .single();
        expect(data.contact_id).toBe(contact!.id);
        expect(contact?.email).toBe(sharedEmail); // el correo capturado primero no se sobreescribe
    });
});

describe('49 — Persistencia de sentiment en call_logs vía process_call_completed', () => {
    const sentimentConvId = `rpc-sentiment-test:${Date.now()}`;
    const sentimentPhone = `+521650009${Math.floor(Math.random() * 9000 + 1000)}`;

    afterAll(async () => {
        await supabaseAdmin.from('leads').delete().eq('conversation_id', sentimentConvId);
        await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', sentimentConvId);
        await supabaseAdmin.from('contacts').delete().eq('phone_e164', sentimentPhone);
    });

    function callRpc49(overrides: Record<string, unknown> = {}) {
        return supabaseAdmin.rpc('process_call_completed', {
            p_organization_id: REAL_ORG_ID,
            p_conversation_id: sentimentConvId,
            p_provider_call_id: sentimentConvId,
            p_caller_phone_e164: sentimentPhone,
            p_full_name: null,
            p_email: null,
            p_business_name: null,
            p_business_sector: null,
            p_contact_phone_raw: null,
            p_inquiry_reason: null,
            p_temperature: null,
            p_booked_appointment: false,
            p_needs_followup: false,
            p_followup_notes: null,
            p_call_volume: null,
            p_transcript: 'Cliente: Hola.\nAgente: ¿En qué te ayudo?',
            p_summary: 'Llamada de prueba.',
            p_duration_seconds: 42,
            ...overrides,
        });
    }

    it('persiste sentiment = "Positivo" en call_logs al pasar p_sentiment', async () => {
        const { data, error } = await callRpc49({
            p_sentiment: 'Positivo',
            p_full_name: 'Prospecto Sentimiento',
        });

        expect(error).toBeNull();
        expect(data.call_log_id).toBeTruthy();

        const { data: callLog } = await supabaseAdmin
            .from('call_logs')
            .select('sentiment')
            .eq('id', data.call_log_id)
            .single();

        expect(callLog?.sentiment).toBe('Positivo');
    });

    it('actualiza sentiment en ON CONFLICT si una llamada se sembró sin sentimiento y luego llega con sentimiento', async () => {
        const conflictConvId = `rpc-sentiment-conflict:${Date.now()}`;

        // 1. Siembra inicial sin sentimiento
        await callRpc49({
            p_conversation_id: conflictConvId,
            p_provider_call_id: conflictConvId,
            p_sentiment: null,
        });

        // 2. Webhook post-call llega con sentimiento "Negativo"
        const { data: second, error } = await callRpc49({
            p_conversation_id: conflictConvId,
            p_provider_call_id: conflictConvId,
            p_sentiment: 'Negativo',
        });

        expect(error).toBeNull();
        const { data: callLog } = await supabaseAdmin
            .from('call_logs')
            .select('sentiment')
            .eq('id', second.call_log_id)
            .single();

        expect(callLog?.sentiment).toBe('Negativo');

        await supabaseAdmin.from('leads').delete().eq('conversation_id', conflictConvId);
        await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', conflictConvId);
    });
});


