-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 41_process_call_completed_source.sql
-- =============================================================================
-- Agrega `p_source`/`p_source_detail` a process_call_completed (D.1,
-- docs/tasks/asistencia-valor de cierre.md) para que el upsert de `leads`
-- capture `leads.source`/`leads.source_detail` (migración 39) — hoy ningún
-- parámetro de esta función los toca, así que aunque las columnas ya
-- existen, nunca se escriben.
--
-- Definición base copiada de db/migrations/27_process_call_completed_fix_on_conflict.sql
-- (la revisión vigente — sin cambios en las secciones 1/2/4, "Sin cambios"
-- se mantiene donde aplicaba). El upsert de leads (sección 3) agrega los dos
-- parámetros nuevos con el mismo patrón `COALESCE(leads.col, NULLIF(p_x, ''))`
-- que ya usan `inquiry_reason`/`temperature`: un reintento de pg-boss nunca
-- sobrescribe un `source` ya capturado con NULL.
--
-- `CREATE OR REPLACE FUNCTION` solo reemplaza cuando la lista de parámetros
-- es IDÉNTICA a la existente — agregar `p_source`/`p_source_detail` cambia
-- la firma, así que Postgres crearía un SEGUNDO overload en vez de
-- reemplazar el anterior (de ahí el error "function name ... is not
-- unique" al correr esta migración: quedaron dos funciones con el mismo
-- nombre). Se eliminan primero TODOS los overloads existentes de
-- process_call_completed (vía introspección de pg_proc, sin necesidad de
-- adivinar la firma exacta de cada versión anterior) para garantizar que
-- solo quede una — la de abajo.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT oid::regprocedure AS sig
        FROM pg_proc
        WHERE proname = 'process_call_completed'
          AND pronamespace = 'public'::regnamespace
    LOOP
        EXECUTE format('DROP FUNCTION %s', r.sig);
    END LOOP;
END $$;

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
    p_usage_entries jsonb DEFAULT '[]'::jsonb,
    p_channel text DEFAULT 'voice',
    p_customer_address text DEFAULT NULL,
    p_customer_city text DEFAULT NULL,
    p_customer_state text DEFAULT NULL,
    p_customer_zip text DEFAULT NULL,
    p_customer_lat numeric DEFAULT NULL,
    p_customer_lng numeric DEFAULT NULL,
    p_source text DEFAULT NULL,
    p_source_detail text DEFAULT NULL
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
    -- 1. Resolución de identidad del contacto. Sin cambios (ver migración 27).
    IF p_caller_phone_e164 IS NOT NULL OR NULLIF(p_email, '') IS NOT NULL THEN
        IF p_caller_phone_e164 IS NOT NULL THEN
            SELECT id INTO v_contact_id
            FROM public.contacts
            WHERE organization_id = p_organization_id AND phone_e164 = p_caller_phone_e164;
        END IF;

        IF v_contact_id IS NULL AND NULLIF(p_email, '') IS NOT NULL THEN
            SELECT id INTO v_contact_id
            FROM public.contacts
            WHERE organization_id = p_organization_id AND lower(email) = lower(p_email)
            ORDER BY last_seen_at DESC
            LIMIT 1;
        END IF;

        IF v_contact_id IS NOT NULL THEN
            UPDATE public.contacts SET
                full_name = COALESCE(public.contacts.full_name, NULLIF(p_full_name, '')),
                email = COALESCE(public.contacts.email, NULLIF(p_email, '')),
                business_name = COALESCE(public.contacts.business_name, NULLIF(p_business_name, '')),
                business_sector = COALESCE(public.contacts.business_sector, NULLIF(p_business_sector, '')),
                last_seen_at = now(),
                last_activity_at = now()
            WHERE id = v_contact_id;
        ELSIF p_caller_phone_e164 IS NOT NULL THEN
            BEGIN
                INSERT INTO public.contacts (
                    organization_id, phone_e164, full_name, email,
                    business_name, business_sector, last_seen_at, last_activity_at
                )
                VALUES (
                    p_organization_id, p_caller_phone_e164, NULLIF(p_full_name, ''), NULLIF(p_email, ''),
                    NULLIF(p_business_name, ''), NULLIF(p_business_sector, ''), now(), now()
                )
                RETURNING id INTO v_contact_id;
            EXCEPTION WHEN unique_violation THEN
                SELECT id INTO v_contact_id
                FROM public.contacts
                WHERE organization_id = p_organization_id AND phone_e164 = p_caller_phone_e164;

                UPDATE public.contacts SET
                    full_name = COALESCE(public.contacts.full_name, NULLIF(p_full_name, '')),
                    email = COALESCE(public.contacts.email, NULLIF(p_email, '')),
                    business_name = COALESCE(public.contacts.business_name, NULLIF(p_business_name, '')),
                    business_sector = COALESCE(public.contacts.business_sector, NULLIF(p_business_sector, '')),
                    last_seen_at = now(),
                    last_activity_at = now()
                WHERE id = v_contact_id;
            END;
        ELSE
            INSERT INTO public.contacts (
                organization_id, phone_e164, full_name, email,
                business_name, business_sector, last_seen_at, last_activity_at
            )
            VALUES (
                p_organization_id, NULL, NULLIF(p_full_name, ''), NULLIF(p_email, ''),
                NULLIF(p_business_name, ''), NULLIF(p_business_sector, ''), now(), now()
            )
            RETURNING id INTO v_contact_id;
        END IF;
    END IF;

    -- 2. Upsert de call_logs por provider_call_id. Sin cambios.
    INSERT INTO public.call_logs (
        organization_id, provider_call_id, contact_id, caller_phone,
        customer_name, customer_email, duration_seconds, transcript,
        summary, call_type, status, channel,
        customer_address, customer_city, customer_state, customer_zip,
        customer_lat, customer_lng
    )
    VALUES (
        p_organization_id, p_provider_call_id, v_contact_id,
        COALESCE(p_caller_phone_e164, NULLIF(p_contact_phone_raw, '')),
        NULLIF(p_full_name, ''), NULLIF(p_email, ''), COALESCE(p_duration_seconds, 0),
        p_transcript, p_summary, 'inbound', 'completed', COALESCE(p_channel, 'voice'),
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
        channel = COALESCE(public.call_logs.channel, EXCLUDED.channel),
        customer_address = COALESCE(public.call_logs.customer_address, EXCLUDED.customer_address),
        customer_city = COALESCE(public.call_logs.customer_city, EXCLUDED.customer_city),
        customer_state = COALESCE(public.call_logs.customer_state, EXCLUDED.customer_state),
        customer_zip = COALESCE(public.call_logs.customer_zip, EXCLUDED.customer_zip),
        customer_lat = COALESCE(public.call_logs.customer_lat, EXCLUDED.customer_lat),
        customer_lng = COALESCE(public.call_logs.customer_lng, EXCLUDED.customer_lng)
    RETURNING id INTO v_call_log_id;

    -- 3. Upsert de lead. AGREGA source/source_detail (esta migración) — mismo
    -- patrón COALESCE que inquiry_reason/temperature: nunca sobrescribe un
    -- valor ya capturado con NULL en un reintento.
    INSERT INTO public.leads (
        organization_id, contact_id, call_log_id, channel, conversation_id,
        full_name, email, contact_phone, business_name, business_sector,
        inquiry_reason, temperature, booked_appointment, needs_followup,
        followup_notes, call_volume, source, source_detail
    )
    VALUES (
        p_organization_id, v_contact_id, v_call_log_id, COALESCE(p_channel, 'voice'), p_conversation_id,
        NULLIF(p_full_name, ''), NULLIF(p_email, ''),
        COALESCE(p_caller_phone_e164, NULLIF(p_contact_phone_raw, '')),
        NULLIF(p_business_name, ''), NULLIF(p_business_sector, ''),
        NULLIF(p_inquiry_reason, ''), NULLIF(p_temperature, ''),
        COALESCE(p_booked_appointment, false), COALESCE(p_needs_followup, false),
        NULLIF(p_followup_notes, ''), NULLIF(p_call_volume, ''),
        NULLIF(p_source, ''), NULLIF(p_source_detail, '')
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
        call_volume = COALESCE(public.leads.call_volume, EXCLUDED.call_volume),
        source = COALESCE(public.leads.source, EXCLUDED.source),
        source_detail = COALESCE(public.leads.source_detail, EXCLUDED.source_detail)
    RETURNING id, (xmax = 0) INTO v_lead_id, v_lead_inserted;

    -- 4. Metering. Sin cambios.
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
    'Persiste de forma atómica el resultado de una llamada: resuelve/crea el contacto por teléfono y, en su defecto, por correo; upsert de call_log; upsert de lead (incluye source/source_detail de atribución de origen, migración 41); e inserción idempotente de usage_events. '
    'Ver Fase 2.2, Fase 3, docs/tasks/opus.md (Fase B), las migraciones de dirección/geocoding y deduplicación de identidad, y docs/tasks/asistencia-valor de cierre.md (D.1) para la atribución de origen.';
