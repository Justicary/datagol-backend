-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- docs/tasks/zero-lead-loss-outbound-persistence.md — Store-First: persistir
-- contacto + lead ANTES de invocar al proveedor de voz, no después. Antes de
-- esta migración, `leads.conversation_id` es NOT NULL con
-- `leads_organization_id_conversation_id_key UNIQUE (organization_id,
-- conversation_id)` — imposible insertar un lead cuando todavía no existe
-- una llamada (ni un conversation_id) que lo origine.
--
-- Se vuelve NULLABLE y la restricción única pasa a ser un índice parcial
-- (`WHERE conversation_id IS NOT NULL`) — mismo idioma ya usado en este
-- repositorio para el mismo problema (`ux_appointments_org_conversation_id`,
-- migración 07; `ux_appointment_waitlist_org_conversation_id`, migración 65):
-- múltiples filas con conversation_id NULL conviven sin conflicto: Postgres
-- nunca las compara entre sí en una restricción UNIQUE/índice parcial.
-- =============================================================================

ALTER TABLE public.leads
    ALTER COLUMN conversation_id DROP NOT NULL;

ALTER TABLE public.leads
    DROP CONSTRAINT IF EXISTS leads_organization_id_conversation_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS ux_leads_org_conversation_id
    ON public.leads (organization_id, conversation_id)
    WHERE conversation_id IS NOT NULL;

-- `process_call_completed` (migración 03, redefinida desde por 41/49/51/52)
-- apunta su `ON CONFLICT (organization_id, conversation_id)` a la
-- restricción única que se acaba de eliminar. Se redefine con el MISMO
-- encabezado de 30 parámetros — solo cambia el `ON CONFLICT` del paso 3
-- (leads) para calzar con el índice parcial nuevo. `p_conversation_id`
-- siempre es NOT NULL en este flujo (el webhook de post-llamada real
-- siempre trae uno), así que el predicado no cambia ningún comportamiento
-- existente — solo permite que la restricción exista como índice parcial.
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
    p_channel text DEFAULT 'voice'::text,
    p_customer_address text DEFAULT NULL::text,
    p_customer_city text DEFAULT NULL::text,
    p_customer_state text DEFAULT NULL::text,
    p_customer_zip text DEFAULT NULL::text,
    p_customer_lat numeric DEFAULT NULL::numeric,
    p_customer_lng numeric DEFAULT NULL::numeric,
    p_source text DEFAULT NULL::text,
    p_source_detail text DEFAULT NULL::text,
    p_sentiment text DEFAULT NULL::text,
    p_plan_of_interest text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
    v_contact_id uuid;
    v_call_log_id uuid;
    v_lead_id uuid;
    v_lead_inserted boolean := false;
    v_usage_events_inserted integer := 0;
BEGIN
    -- 1. Resolución de identidad del contacto. Sin cambios (ver migración 27/41).
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
        summary, sentiment, call_type, status, channel,
        customer_address, customer_city, customer_state, customer_zip,
        customer_lat, customer_lng
    )
    VALUES (
        p_organization_id, p_provider_call_id, v_contact_id,
        COALESCE(p_caller_phone_e164, NULLIF(p_contact_phone_raw, '')),
        NULLIF(p_full_name, ''), NULLIF(p_email, ''), COALESCE(p_duration_seconds, 0),
        p_transcript, p_summary, NULLIF(p_sentiment, ''), 'inbound', 'completed', COALESCE(p_channel, 'voice'),
        NULLIF(p_customer_address, ''), NULLIF(p_customer_city, ''),
        NULLIF(p_customer_state, ''), NULLIF(p_customer_zip, ''),
        p_customer_lat, p_customer_lng
    )
    ON CONFLICT (provider_call_id) DO UPDATE SET
        contact_id = COALESCE(public.call_logs.contact_id, EXCLUDED.contact_id),
        transcript = EXCLUDED.transcript,
        summary = EXCLUDED.summary,
        sentiment = COALESCE(EXCLUDED.sentiment, public.call_logs.sentiment),
        duration_seconds = EXCLUDED.duration_seconds,
        customer_name = COALESCE(EXCLUDED.customer_name, public.call_logs.customer_name),
        customer_email = COALESCE(EXCLUDED.customer_email, public.call_logs.customer_email),
        channel = COALESCE(public.call_logs.channel, EXCLUDED.channel),
        customer_address = COALESCE(EXCLUDED.customer_address, public.call_logs.customer_address),
        customer_city = COALESCE(EXCLUDED.customer_city, public.call_logs.customer_city),
        customer_state = COALESCE(EXCLUDED.customer_state, public.call_logs.customer_state),
        customer_zip = COALESCE(EXCLUDED.customer_zip, public.call_logs.customer_zip),
        customer_lat = COALESCE(EXCLUDED.customer_lat, public.call_logs.customer_lat),
        customer_lng = COALESCE(EXCLUDED.customer_lng, public.call_logs.customer_lng)
    RETURNING id INTO v_call_log_id;

    -- 3. Upsert de lead. ÚNICO CAMBIO de esta migración: el arbiter del
    -- ON CONFLICT ahora incluye el predicado del índice parcial
    -- (`ux_leads_org_conversation_id`) en vez de la restricción única que
    -- existía antes de esta migración.
    INSERT INTO public.leads (
        organization_id, contact_id, call_log_id, channel, conversation_id,
        full_name, email, contact_phone, business_name, business_sector,
        inquiry_reason, plan_of_interest, temperature, booked_appointment, needs_followup,
        followup_notes, call_volume, source, source_detail
    )
    VALUES (
        p_organization_id, v_contact_id, v_call_log_id, COALESCE(p_channel, 'voice'), p_conversation_id,
        NULLIF(p_full_name, ''), NULLIF(p_email, ''),
        COALESCE(p_caller_phone_e164, NULLIF(p_contact_phone_raw, '')),
        NULLIF(p_business_name, ''), NULLIF(p_business_sector, ''),
        NULLIF(p_inquiry_reason, ''), NULLIF(p_plan_of_interest, ''), NULLIF(p_temperature, ''),
        COALESCE(p_booked_appointment, false), COALESCE(p_needs_followup, false),
        NULLIF(p_followup_notes, ''), NULLIF(p_call_volume, ''),
        NULLIF(p_source, ''), NULLIF(p_source_detail, '')
    )
    ON CONFLICT (organization_id, conversation_id) WHERE conversation_id IS NOT NULL DO UPDATE SET
        channel = COALESCE(public.leads.channel, EXCLUDED.channel),
        contact_id = COALESCE(public.leads.contact_id, EXCLUDED.contact_id),
        call_log_id = COALESCE(public.leads.call_log_id, EXCLUDED.call_log_id),
        full_name = COALESCE(public.leads.full_name, EXCLUDED.full_name),
        email = COALESCE(public.leads.email, EXCLUDED.email),
        business_name = COALESCE(public.leads.business_name, EXCLUDED.business_name),
        business_sector = COALESCE(public.leads.business_sector, EXCLUDED.business_sector),
        inquiry_reason = COALESCE(public.leads.inquiry_reason, EXCLUDED.inquiry_reason),
        plan_of_interest = COALESCE(public.leads.plan_of_interest, EXCLUDED.plan_of_interest),
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
$function$;

-- =============================================================================
-- `seed_outbound_lead` — Fase 1 de Zero Lead Loss (Store-First). Se llama
-- ANTES de disparar la llamada: upsert de contacto + insert de lead SIN
-- conversation_id (todavía no existe una llamada). Atómica por ser una sola
-- función plpgsql (una transacción implícita) — si el INSERT de leads
-- falla, el upsert de contacts de este mismo llamado se revierte también.
--
-- Deliberadamente NO reutiliza `process_call_completed`: esa función
-- representa una llamada YA TERMINADA (crea call_logs con status
-- 'completed', duración, transcripción) — usarla para un intento que ni
-- siquiera ha marcado todavía corrompería call_logs con un estado falso.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.seed_outbound_lead(
    p_organization_id uuid,
    p_phone_e164 text,
    p_full_name text,
    p_email text,
    p_business_name text,
    p_business_sector text,
    p_inquiry_reason text,
    p_source text DEFAULT NULL::text,
    p_source_detail text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
    v_contact_id uuid;
    v_lead_id uuid;
BEGIN
    -- Los datos que llegan de un formulario recién tecleado por la persona
    -- son más frescos que lo que ya hubiera en `contacts` de una llamada
    -- anterior — a diferencia de `process_call_completed` (que prefiere NO
    -- sobreescribir), aquí el valor nuevo gana si viene presente.
    INSERT INTO public.contacts (
        organization_id, phone_e164, full_name, email,
        business_name, business_sector, last_seen_at, last_activity_at
    )
    VALUES (
        p_organization_id, p_phone_e164, NULLIF(p_full_name, ''), NULLIF(p_email, ''),
        NULLIF(p_business_name, ''), NULLIF(p_business_sector, ''), now(), now()
    )
    ON CONFLICT (organization_id, phone_e164) WHERE phone_e164 IS NOT NULL DO UPDATE SET
        full_name = COALESCE(EXCLUDED.full_name, public.contacts.full_name),
        email = COALESCE(EXCLUDED.email, public.contacts.email),
        business_name = COALESCE(EXCLUDED.business_name, public.contacts.business_name),
        business_sector = COALESCE(EXCLUDED.business_sector, public.contacts.business_sector),
        last_seen_at = now(),
        last_activity_at = now()
    RETURNING id INTO v_contact_id;

    INSERT INTO public.leads (
        organization_id, contact_id, channel, conversation_id,
        full_name, email, contact_phone, business_name, business_sector,
        inquiry_reason, source, source_detail
    )
    VALUES (
        p_organization_id, v_contact_id, 'voice', NULL,
        NULLIF(p_full_name, ''), NULLIF(p_email, ''), p_phone_e164,
        NULLIF(p_business_name, ''), NULLIF(p_business_sector, ''),
        NULLIF(p_inquiry_reason, ''), NULLIF(p_source, ''), NULLIF(p_source_detail, '')
    )
    RETURNING id INTO v_lead_id;

    RETURN jsonb_build_object('contact_id', v_contact_id, 'lead_id', v_lead_id);
END;
$function$;
