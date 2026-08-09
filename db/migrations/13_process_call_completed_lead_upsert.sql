-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- docs/tasks/outbound-lead-persistence-and-rate-limit.md — Problema 1.5.
--
-- La siembra inmediata de leads en la llamada saliente (voice.ts, 1.3 de la
-- misma tarea, se dispara en cuanto ElevenLabs confirma el conversation_id,
-- antes de que exista transcripción) llama a esta misma función. Con el
-- `ON CONFLICT (organization_id, conversation_id) DO NOTHING` original de la
-- migración 05, cuando el webhook real de post-llamada llega minutos después
-- con `temperature`/`booked_appointment`/`needs_followup` capturados en vivo,
-- esos datos se descartaban en silencio — el conflicto no actualizaba nada.
--
-- Se cambia a `DO UPDATE` con el mismo patrón `COALESCE` que ya usan
-- `contacts` y `call_logs` en esta misma función: `full_name`/`email`/
-- `business_name`/`business_sector`/`inquiry_reason` (más confiables cuando
-- vienen del formulario, tecleados por la persona) solo se completan si
-- estaban vacíos, nunca se sobrescriben. `booked_appointment`/
-- `needs_followup` usan OR: cualquiera de las dos llamadas (siembra o
-- webhook) que reporte `true` gana, sin importar el orden de llegada.
--
-- La firma de la función no cambia (sigue la de 19 parámetros de la
-- migración 05), así que `CREATE OR REPLACE FUNCTION` basta — no hace falta
-- el `DROP FUNCTION` que sí fue necesario al pasar de 18 a 19 parámetros.
--
-- `lead_inserted`: con `DO UPDATE`, `RETURNING id` ya no da NULL en un
-- conflicto, así que el patrón "IF v_lead_id IS NOT NULL" de la migración 05
-- para distinguir insert de update dejó de servir. Se usa el truco estándar
-- de Postgres `xmax = 0`: `xmax` es el identificador de la transacción que
-- expiró la fila, vale 0 en una fila recién insertada dentro de la misma
-- sentencia y distinto de 0 tras un UPDATE — preserva la distinción sin una
-- consulta adicional. Verificado contra `process-call-completed-rpc.test.ts`,
-- que depende de `lead_inserted: false` en un reintento con los mismos datos.
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

    -- 3. Upsert de lead. conversation_id da idempotencia de negocio: en un
    --    reintento (o en la fusión siembra-de-formulario + webhook real), el
    --    conflicto ya no descarta el segundo evento — lo fusiona.
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
    ON CONFLICT (organization_id, conversation_id) DO UPDATE SET
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
    'llega después) e inserción idempotente de usage_events. '
    'Ver Fase 2.2, Fase 3 y docs/tasks/outbound-lead-persistence-and-rate-limit.md.';
