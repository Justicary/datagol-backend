import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { supabaseAdmin } from '../src/lib/supabase.js';

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
