-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Fase 2 — Webhook de post-llamada de ElevenLabs.
-- Función `process_call_completed`: persiste en una sola transacción el
-- upsert de contacto, el upsert de call_logs y el insert idempotente de
-- lead, para la llamada completada que reporta el webhook.
--
-- Nota: las restricciones únicas que dan idempotencia a este flujo ya
-- existen en el esquema y se verificaron contra la base real antes de
-- escribir esta función (no se asumieron):
--   - webhook_events_provider_event_id_key   UNIQUE (provider, event_id)
--   - leads_organization_id_conversation_id_key  UNIQUE (organization_id, conversation_id)
--   - call_logs_vapi_call_id_key              UNIQUE (provider_call_id)  -- global, no por organización
--   - contacts_organization_id_phone_e164_key UNIQUE (organization_id, phone_e164)
-- Por eso esta migración no crea índices nuevos, solo la función.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.process_call_completed(
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
    p_duration_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_contact_id uuid;
    v_call_log_id uuid;
    v_lead_id uuid;
    v_lead_inserted boolean := false;
BEGIN
    -- 1. Upsert de contacto por (organization_id, phone_e164).
    --    Regla de honestidad de datos: rellena solo columnas vacías, nunca
    --    sobrescribe un dato bueno con uno nuevo vacío (COALESCE conserva lo
    --    existente; NULLIF trata la cadena vacía como ausencia de dato).
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

    -- 2. Upsert de call_logs por provider_call_id (la restricción única
    --    existente, call_logs_vapi_call_id_key, es global — no compuesta con
    --    organization_id — porque el conversation_id de ElevenLabs ya es
    --    único entre todos los clientes). Es el único evento del sistema que
    --    conoce esta llamada, así que si no existe la crea; si ya existe
    --    (reintento) la actualiza.
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

    -- 3. Insert de lead. conversation_id da idempotencia de negocio: en un
    --    reintento, el conflicto no inserta una segunda fila, se recupera la
    --    ya existente.
    INSERT INTO public.leads (
        organization_id, contact_id, call_log_id, channel, conversation_id,
        full_name, email, contact_phone, business_name, business_sector,
        inquiry_reason, temperature, booked_appointment, needs_followup,
        followup_notes, call_volume
    )
    VALUES (
        p_organization_id, v_contact_id, v_call_log_id, 'voice', p_conversation_id,
        NULLIF(p_full_name, ''), NULLIF(p_email, ''),
        COALESCE(p_caller_phone_e164, NULLIF(p_contact_phone_raw, '')),
        NULLIF(p_business_name, ''), NULLIF(p_business_sector, ''),
        NULLIF(p_inquiry_reason, ''), NULLIF(p_temperature, ''),
        COALESCE(p_booked_appointment, false), COALESCE(p_needs_followup, false),
        NULLIF(p_followup_notes, ''), NULLIF(p_call_volume, '')
    )
    ON CONFLICT (organization_id, conversation_id) DO NOTHING
    RETURNING id INTO v_lead_id;

    IF v_lead_id IS NOT NULL THEN
        v_lead_inserted := true;
    ELSE
        SELECT id INTO v_lead_id
        FROM public.leads
        WHERE organization_id = p_organization_id AND conversation_id = p_conversation_id;
    END IF;

    RETURN jsonb_build_object(
        'contact_id', v_contact_id,
        'call_log_id', v_call_log_id,
        'lead_id', v_lead_id,
        'lead_inserted', v_lead_inserted
    );
END;
$$;

COMMENT ON FUNCTION public.process_call_completed IS
    'Persiste de forma atómica el resultado de una llamada completada de ElevenLabs: '
    'upsert de contacto, upsert de call_log e insert idempotente de lead. '
    'Ver Fase 2.2 de docs/tasks/backend-implementation.md. '
    'Los pasos de metering (Fase 3) y notificaciones (Fase 4) NO están cubiertos por esta función.';
