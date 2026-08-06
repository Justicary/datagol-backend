-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Fase 3 — Metering. Extiende `process_call_completed` (Fase 2.2) para
-- insertar, en la misma transacción, los asientos de consumo ya resueltos en
-- JS (tarifa + cantidad vienen calculados por src/services/usage-registration.ts,
-- que a su vez usa src/services/rate-service.ts para no aplicar nunca la
-- tarifa actual a un consumo pasado — ver §3.1 de
-- docs/tasks/backend-implementation.md).
--
-- Idempotencia de usage_events:
-- `usage_events` no tenía ninguna restricción única (solo su PRIMARY KEY) —
-- verificado contra la base real antes de escribir esta migración, no
-- asumido. Sin eso, un reintento de pg-boss duplicaría los asientos de una
-- misma llamada. Se agrega `idempotency_key` NULLABLE + UNIQUE:
--   - Los asientos automáticos de este job siempre la fijan
--     (`conversation_id:provider:unit_type`), así que ON CONFLICT DO NOTHING
--     los protege de reintentos.
--   - Los asientos compensatorios manuales (corrección de un error de
--     cobro, AGENTS.md §3.2/§6) la dejan NULL a propósito: en Postgres NULL
--     nunca colisiona con otro NULL bajo UNIQUE, así que una corrección para
--     el mismo (organization_id, call_log_id, provider, unit_type) que el
--     asiento original nunca queda bloqueada por esta restricción.
-- =============================================================================

ALTER TABLE public.usage_events ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS usage_events_idempotency_key_key
    ON public.usage_events (idempotency_key);

COMMENT ON COLUMN public.usage_events.idempotency_key IS
    'Clave de idempotencia de asientos automáticos: conversation_id:provider:unit_type. '
    'NULL en asientos compensatorios manuales (no participan en la restricción UNIQUE). '
    'Ver Fase 3 de docs/tasks/backend-implementation.md.';

-- CREATE OR REPLACE FUNCTION exige que la lista de parámetros coincida
-- exactamente con la existente para reemplazarla; añadir un parámetro nuevo
-- (aunque tenga DEFAULT) crea un overload adicional en vez de sustituirla, y
-- deja el nombre de función ambiguo para sentencias que no listan tipos
-- (p. ej. COMMENT ON FUNCTION). Se elimina explícitamente la firma de
-- Fase 2.2 (18 parámetros, sin p_usage_entries) antes de crear la de Fase 3.
DROP FUNCTION IF EXISTS public.process_call_completed(
    uuid, text, text, text, text, text, text, text, text, text, text,
    boolean, boolean, text, text, text, text, integer
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
    p_usage_entries jsonb DEFAULT '[]'::jsonb
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

    -- 4. Metering (Fase 3): inserta los asientos de consumo ya resueltos en
    --    JS (provider, unit_type, quantity, unit_rate_usd, idempotency_key).
    --    usage_events no admite UPDATE/DELETE (trigger trg_usage_no_update),
    --    así que ON CONFLICT DO NOTHING sobre idempotency_key es la única vía
    --    de idempotencia: un reintento de pg-boss no duplica los asientos.
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
    'Persiste de forma atómica el resultado de una llamada completada de ElevenLabs: '
    'upsert de contacto, upsert de call_log, insert idempotente de lead, e inserción '
    'idempotente de los asientos de consumo (usage_events) ya resueltos en JS. '
    'Ver Fase 2.2 y Fase 3 de docs/tasks/backend-implementation.md. '
    'Las notificaciones (Fase 4) NO están cubiertas por esta función.';
