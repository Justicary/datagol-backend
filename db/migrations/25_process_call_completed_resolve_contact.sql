-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Fase B (docs/tasks/opus.md — pipeline/ciclo de vida/direcciones de contacto).
--
-- CONTEXTO: la migración que agregó `contacts.lifecycle_stage`,
-- `contacts.pipeline_stage`, `contact_addresses`, `resolve_contact()` y
-- `resolve_contact_address()` se aplicó directamente contra producción y NO
-- tiene un archivo correspondiente en este directorio (verificado: ningún
-- archivo existente menciona esos objetos). Se documenta aquí porque es la
-- primera vez que este repo modifica algo que depende de ella. El esquema
-- real (columnas, CHECK constraints, firma de las funciones) se verificó por
-- inspección directa contra la base — no se asume nada de este comentario.
--
-- ESTE CAMBIO: `process_call_completed` (última versión en migración 21)
-- tenía su propia lógica de resolución de contacto duplicada inline (SELECT
-- por teléfono, luego por correo, luego INSERT con ON CONFLICT). Ahora que
-- existe `resolve_contact(p_org_id, p_phone, p_email)` como primitiva
-- compartida (misma lógica teléfono→correo→nuevo, ya usada también por
-- routes/tools/booking.ts en la Fase C de esta misma tarea), se delega ahí
-- en vez de mantener dos implementaciones que podrían divergir.
--
-- Solo cambia la sección 1 (resolución de identidad) de la función. Las
-- secciones 2 (call_logs), 3 (leads) y 4 (usage_events) se copian tal cual
-- de la migración 21, sin modificar.
--
-- CAMBIO DE COMPORTAMIENTO DELIBERADO: el guard para resolver contacto pasa
-- de `IF p_caller_phone_e164 IS NOT NULL` a `IF teléfono O correo presente`.
-- Antes, una conversación sin teléfono (viable solo en whatsapp/web, donde
-- el widget no siempre da caller ID) nunca resolvía contact_id aunque
-- trajera correo — exactamente el caso "contacto sin teléfono (widget web)"
-- que la tarea pide cubrir con test. `resolve_contact` ya soporta
-- resolución solo por correo, así que ampliar el guard es la forma correcta
-- de aprovecharlo, no un efecto secundario accidental.
--
-- `last_activity_at` se actualiza también en el UPDATE de enriquecimiento:
-- es la columna que usa `v_pipeline_kanban` para ordenar por actividad
-- reciente — dejarla sin tocar aquí la volvería incorrecta para toda
-- conversación entrante procesada por este RPC.
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
    -- 1. Resolución de identidad delegada a resolve_contact() (teléfono →
    --    correo → nuevo, ver comentario de cabecera). Solo se invoca si hay
    --    al menos un identificador — sin ninguno, no hay identidad que
    --    resolver ni tiene sentido crear un contacto vacío (contacts tiene
    --    su propio CHECK contacts_identity_present que lo impediría de
    --    todos modos).
    IF p_caller_phone_e164 IS NOT NULL OR NULLIF(p_email, '') IS NOT NULL THEN
        v_contact_id := public.resolve_contact(p_organization_id, p_caller_phone_e164, NULLIF(p_email, ''));

        UPDATE public.contacts SET
            full_name = COALESCE(public.contacts.full_name, NULLIF(p_full_name, '')),
            email = COALESCE(public.contacts.email, NULLIF(p_email, '')),
            business_name = COALESCE(public.contacts.business_name, NULLIF(p_business_name, '')),
            business_sector = COALESCE(public.contacts.business_sector, NULLIF(p_business_sector, '')),
            last_seen_at = now(),
            last_activity_at = now()
        WHERE id = v_contact_id;
    END IF;

    -- 2. Upsert de call_logs por provider_call_id. Sin cambios respecto a la
    --    migración 21 (incluye channel, dirección de servicio y coordenadas
    --    geocodificadas).
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

    -- 3. Upsert de lead. Sin cambios respecto a la migración 21.
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
    'Persiste de forma atómica el resultado de una llamada: resuelve/crea el contacto vía resolve_contact() (teléfono → correo → nuevo, compartida con resolve_contact_address y routes/tools/booking.ts), upsert de call_log (incluye channel, dirección de servicio y coordenadas geocodificadas), upsert de lead (DO UPDATE con COALESCE) e inserción idempotente de usage_events. '
    'Ver Fase 2.2, Fase 3, docs/tasks/opus.md (Fase B) y las migraciones de dirección/geocoding, deduplicación de identidad y pipeline/lifecycle de contacto.';
