-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- El agente ahora captura la dirección de servicio del prospecto en
-- Analysis → Data Collection de ElevenLabs (`direccion_prospecto`,
-- `ciudad_prospecto`, `estado_prospecto`, `cp_prospecto`), pero
-- `process_call_completed` no tenía parámetros para persistirla:
-- `call_logs.customer_address/city/state/zip/lat/lng` existían en el
-- esquema (heredadas del pipeline de Vapi, `jobs/process-vapi-call-completed.ts`,
-- que ya no corre para llamadas de ElevenLabs) pero ningún llamador actual
-- las llenaba. Esta migración cierra ese hueco para el pipeline de
-- ElevenLabs (src/services/call-payload-mapper.ts, jobs/process-call-completed.ts).
--
-- 1. `organization_secrets.secret_key` admite ahora 'google_maps_key': llave
--    de la API de Geocoding de Google Maps, por organización (igual patrón
--    que 'cal_api_key'). Si una organización no la configura, la
--    geocodificación simplemente se omite (customer_lat/lng quedan NULL) —
--    nunca bloquea la persistencia del resto de la llamada.
--
-- 2. `process_call_completed` gana 6 parámetros nuevos, todos con DEFAULT
--    NULL (compatibilidad hacia atrás con llamadores que no los manden):
--    p_customer_address/city/state/zip (texto, tal como los dicta el
--    prospecto) y p_customer_lat/lng (numeric, resueltos por
--    services/geocoding.ts ANTES de invocar el RPC — el RPC no llama a
--    Google Maps, solo persiste). Mismo patrón COALESCE que
--    full_name/email: un dato ya bueno en call_logs nunca se pisa con uno
--    vacío de un reintento del webhook.
--
--    La firma cambia (se agregan parámetros), así que hace falta DROP +
--    CREATE — mismo criterio que las migraciones 05 y 14 al agregar
--    p_usage_entries y p_channel — no basta con CREATE OR REPLACE.
-- =============================================================================

ALTER TABLE public.organization_secrets
    DROP CONSTRAINT IF EXISTS organization_secrets_secret_key_check;

ALTER TABLE public.organization_secrets
    ADD CONSTRAINT organization_secrets_secret_key_check
    CHECK (secret_key = ANY (ARRAY[
        'elevenlabs_api_key'::text,
        'telnyx_api_key'::text,
        'whatsapp_access_token'::text,
        'cal_api_key'::text,
        'meta_app_secret'::text,
        'webhook_signing_secret'::text,
        'tool_webhook_secret'::text,
        'google_maps_key'::text
    ]));

DROP FUNCTION IF EXISTS public.process_call_completed(
    uuid, text, text, text, text, text, text, text, text, text, text,
    boolean, boolean, text, text, text, text, integer, jsonb, text
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
    p_channel text DEFAULT 'voice',
    p_customer_address text DEFAULT NULL,
    p_customer_city text DEFAULT NULL,
    p_customer_state text DEFAULT NULL,
    p_customer_zip text DEFAULT NULL,
    p_customer_lat numeric DEFAULT NULL,
    p_customer_lng numeric DEFAULT NULL
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

    -- 2. Upsert de call_logs por provider_call_id. Ahora incluye dirección
    --    de servicio y coordenadas geocodificadas (Fase de captura de
    --    dirección del prospecto).
    INSERT INTO public.call_logs (
        organization_id, provider_call_id, contact_id, caller_phone,
        customer_name, customer_email, duration_seconds, transcript,
        summary, call_type, status,
        customer_address, customer_city, customer_state, customer_zip,
        customer_lat, customer_lng
    )
    VALUES (
        p_organization_id, p_provider_call_id, v_contact_id,
        COALESCE(p_caller_phone_e164, NULLIF(p_contact_phone_raw, '')),
        NULLIF(p_full_name, ''), NULLIF(p_email, ''), COALESCE(p_duration_seconds, 0),
        p_transcript, p_summary, 'inbound', 'completed',
        NULLIF(p_customer_address, ''), NULLIF(p_customer_city, ''),
        NULLIF(p_customer_state, ''), NULLIF(p_customer_zip, ''),
        p_customer_lat, p_customer_lng
    )
    ON CONFLICT (provider_call_id) DO UPDATE SET
        contact_id = COALESCE(public.call_logs.contact_id, EXCLUDED.contact_id),
        transcript = EXCLUDED.transcript,
        summary = EXCLUDED.summary,
        duration_seconds = EXCLUDED.duration_seconds,
        customer_name = COALESCE(public.call_logs.customer_name, EXCLUDED.customer_name),
        customer_email = COALESCE(public.call_logs.customer_email, EXCLUDED.customer_email),
        customer_address = COALESCE(public.call_logs.customer_address, EXCLUDED.customer_address),
        customer_city = COALESCE(public.call_logs.customer_city, EXCLUDED.customer_city),
        customer_state = COALESCE(public.call_logs.customer_state, EXCLUDED.customer_state),
        customer_zip = COALESCE(public.call_logs.customer_zip, EXCLUDED.customer_zip),
        customer_lat = COALESCE(public.call_logs.customer_lat, EXCLUDED.customer_lat),
        customer_lng = COALESCE(public.call_logs.customer_lng, EXCLUDED.customer_lng)
    RETURNING id INTO v_call_log_id;

    -- 3. Upsert de lead. Sin cambios respecto a la migración 14.
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
    'upsert de call_log (incluye dirección de servicio y coordenadas '
    'geocodificadas del prospecto), upsert de lead (DO UPDATE con COALESCE, '
    'fusiona la siembra de formulario de una llamada outbound con el webhook '
    'real que llega después; channel viaja como parámetro, ya no fijo a '
    '''voice'') e inserción idempotente de usage_events. '
    'Ver Fase 2.2, Fase 3, docs/tasks/outbound-lead-persistence-and-rate-limit.md, '
    'la tarea de channel/LLM tokens/continuidad cross-canal, y la migración '
    'de captura de dirección/geocoding.';
