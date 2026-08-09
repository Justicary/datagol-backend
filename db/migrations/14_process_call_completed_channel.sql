-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- `process_call_completed` escribía `'voice'` a fuego en `leads.channel`
-- para TODO lead, sin importar el canal real de la conversación. Verificado
-- contra un caso real de producción: conv_6201kzkmwnd8e658dn4c8fqg1c0d es una
-- conversación de WhatsApp (`metadata.conversation_initiation_source =
-- 'whatsapp'`) y quedó guardada con `channel = 'voice'`.
--
-- Se agrega `p_channel text DEFAULT 'voice'` — DEFAULT por seguridad (si algún
-- llamador no lo manda, cae al valor histórico en vez de fallar), pero
-- src/services/call-payload-mapper.ts ya lo deriva siempre de
-- `conversation_initiation_source` (ver src/types/lead-enums.ts,
-- LEAD_CHANNELS) y ambos llamadores del RPC (jobs/process-call-completed.ts,
-- routes/voice.ts) lo pasan explícito.
--
-- `channel` se preserva con el mismo patrón COALESCE que full_name/email en
-- el upsert: el primer valor escrito (siembra o webhook, lo que llegue
-- primero) gana. En la práctica el canal no cambia entre la siembra de una
-- llamada outbound (siempre 'voice') y su webhook real, así que esto es
-- más defensivo que necesario, pero mantiene la simetría con el resto de
-- columnas "pegajosas" de la función.
--
-- La firma cambia (se agrega un parámetro), así que hace falta DROP + CREATE
-- — igual que en la migración 05 al pasar de 18 a 19 parámetros — no basta
-- con CREATE OR REPLACE.
-- =============================================================================

DROP FUNCTION IF EXISTS public.process_call_completed(
    uuid, text, text, text, text, text, text, text, text, text, text,
    boolean, boolean, text, text, text, text, integer, jsonb
);

CREATE FUNCTION public.process_call_completed(
    p_organization_id uuid,
    p_conversation_id text,
    p_provider_call_id text,
    p_caller_phone_e164 text,
    p_full_name text,
    p_email text,
    p_business_name text,
    p_business_sector text,
    p_contact_phone_raw text,
    p_inquiry_reason text,
    p_temperature text,
    p_booked_appointment boolean,
    p_needs_followup boolean,
    p_followup_notes text,
    p_call_volume text,
    p_transcript text,
    p_summary text,
    p_duration_seconds integer,
    p_usage_entries jsonb DEFAULT '[]'::jsonb,
    p_channel text DEFAULT 'voice'
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_contact_id uuid;
    v_call_log_id uuid;
    v_lead_id uuid;
    v_lead_inserted boolean := false;
    v_usage_events_inserted integer := 0;
BEGIN
    -- 1. Upsert de contacto por (organization_id, phone_e164). Sin cambios.
    IF p_caller_phone_e164 IS NOT NULL THEN
        INSERT INTO public.contacts (
            organization_id, phone_e164, full_name, email,
            business_name, business_sector, last_seen_at
        )
        VALUES (
            p_organization_id, p_caller_phone_e164, NULLIF(p_full_name, ''), NULLIF(p_email, ''),
            NULLIF(p_business_name, ''), NULLIF(p_business_sector, ''), now()
        )
        ON CONFLICT (organization_id, phone_e164) DO UPDATE SET
            full_name = COALESCE(public.contacts.full_name, EXCLUDED.full_name),
            email = COALESCE(public.contacts.email, EXCLUDED.email),
            business_name = COALESCE(public.contacts.business_name, EXCLUDED.business_name),
            business_sector = COALESCE(public.contacts.business_sector, EXCLUDED.business_sector),
            last_seen_at = now()
        RETURNING id INTO v_contact_id;
    END IF;

    -- 2. Upsert de call_logs por provider_call_id. Sin cambios.
    INSERT INTO public.call_logs (
        organization_id, provider_call_id, contact_id, caller_phone,
        customer_name, customer_email, duration_seconds, transcript,
        summary, call_type, status
    )
    VALUES (
        p_organization_id, p_provider_call_id, v_contact_id,
        COALESCE(p_caller_phone_e164, NULLIF(p_contact_phone_raw, '')),
        NULLIF(p_full_name, ''), NULLIF(p_email, ''), COALESCE(p_duration_seconds, 0),
        p_transcript, p_summary, 'inbound', 'completed'
    )
    ON CONFLICT (provider_call_id) DO UPDATE SET
        contact_id = COALESCE(public.call_logs.contact_id, EXCLUDED.contact_id),
        transcript = EXCLUDED.transcript,
        summary = EXCLUDED.summary,
        duration_seconds = EXCLUDED.duration_seconds,
        customer_name = COALESCE(public.call_logs.customer_name, EXCLUDED.customer_name),
        customer_email = COALESCE(public.call_logs.customer_email, EXCLUDED.customer_email)
    RETURNING id INTO v_call_log_id;

    -- 3. Upsert de lead. `channel` ahora viene del llamador (COALESCE(p_channel,
    --    'voice') solo por si algún caller viejo mandara NULL explícito;
    --    el DEFAULT del parámetro ya cubre el caso de no mandarlo).
    INSERT INTO public.leads (
        organization_id, contact_id, call_log_id, channel, conversation_id,
        full_name, email, contact_phone, business_name, business_sector,
        inquiry_reason, temperature, booked_appointment, needs_followup,
        followup_notes, call_volume
    )
    VALUES (
        p_organization_id, v_contact_id, v_call_log_id, COALESCE(p_channel, 'voice'), p_conversation_id,
        NULLIF(p_full_name, ''), NULLIF(p_email, ''),
        COALESCE(p_caller_phone_e164, NULLIF(p_contact_phone_raw, '')),
        NULLIF(p_business_name, ''), NULLIF(p_business_sector, ''),
        NULLIF(p_inquiry_reason, ''), NULLIF(p_temperature, ''),
        COALESCE(p_booked_appointment, false), COALESCE(p_needs_followup, false),
        NULLIF(p_followup_notes, ''), NULLIF(p_call_volume, '')
    )
    ON CONFLICT (organization_id, conversation_id) DO UPDATE SET
        channel = COALESCE(public.leads.channel, EXCLUDED.channel),
        full_name = COALESCE(public.leads.full_name, EXCLUDED.full_name),
        email = COALESCE(public.leads.email, EXCLUDED.email),
        business_name = COALESCE(public.leads.business_name, EXCLUDED.business_name),
        business_sector = COALESCE(public.leads.business_sector, EXCLUDED.business_sector),
        inquiry_reason = COALESCE(public.leads.inquiry_reason, EXCLUDED.inquiry_reason),
        temperature = COALESCE(public.leads.temperature, EXCLUDED.temperature),
        booked_appointment = public.leads.booked_appointment OR EXCLUDED.booked_appointment,
        needs_followup = public.leads.needs_followup OR EXCLUDED.needs_followup,
        followup_notes = COALESCE(public.leads.followup_notes, EXCLUDED.followup_notes),
        call_volume = COALESCE(public.leads.call_volume, EXCLUDED.call_volume)
    RETURNING id, (xmax = 0) INTO v_lead_id, v_lead_inserted;

    -- 4. Metering (Fase 3). Sin cambios.
    WITH inserted AS (
        INSERT INTO public.usage_events (
            organization_id, provider, unit_type, quantity, unit_rate_usd,
            conversation_id, call_log_id, occurred_at, idempotency_key
        )
        SELECT
            p_organization_id,
            e.provider,
            e.unit_type,
            e.quantity,
            e.unit_rate_usd,
            p_conversation_id,
            v_call_log_id,
            e.occurred_at,
            e.idempotency_key
        FROM jsonb_to_recordset(p_usage_entries) AS e(
            provider text,
            unit_type text,
            quantity numeric,
            unit_rate_usd numeric,
            occurred_at timestamptz,
            idempotency_key text
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO v_usage_events_inserted FROM inserted;

    RETURN jsonb_build_object(
        'contact_id', v_contact_id,
        'call_log_id', v_call_log_id,
        'lead_id', v_lead_id,
        'lead_inserted', v_lead_inserted,
        'usage_events_inserted', v_usage_events_inserted
    );
END;
$$;

COMMENT ON FUNCTION public.process_call_completed IS
    'Persiste de forma atómica el resultado de una llamada: upsert de contacto, '
    'upsert de call_log, upsert de lead (DO UPDATE con COALESCE, fusiona la '
    'siembra de formulario de una llamada outbound con el webhook real que '
    'llega después; channel viaja como parámetro, ya no fijo a ''voice'') '
    'e inserción idempotente de usage_events. '
    'Ver Fase 2.2, Fase 3, docs/tasks/outbound-lead-persistence-and-rate-limit.md '
    'y la tarea de channel/LLM tokens/continuidad cross-canal.';
