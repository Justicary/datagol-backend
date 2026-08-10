-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Dos correcciones independientes descubiertas auditando el dashboard
-- (datagol-frontend):
--
-- 1. `call_logs` no tenía columna `channel`: el dashboard (Distribución por
--    Canal, Actividad Reciente) etiquetaba el 100% de las interacciones como
--    "Voz" porque no había ningún dato real de canal en esa tabla — ni
--    siquiera para conversaciones de WhatsApp, que sí llegan a `call_logs`.
--    El canal real ya se calculaba correctamente para `leads.channel`
--    (`deriveChannel()`, migración 14); simplemente nunca se escribía
--    también en `call_logs`. Se reutiliza el mismo `p_channel` que el
--    llamador ya manda — sin parámetro nuevo, sin tocar
--    jobs/process-call-completed.ts ni routes/voice.ts.
--
-- 2. Identidad de contacto solo por teléfono (Fase 8.4 — deduplicación
--    cross-canal): `contacts` deduplicaba únicamente por
--    `(organization_id, phone_e164)`. Si la misma persona contacta por dos
--    canales donde el teléfono capturado difiere (típicamente: un número
--    dictado por voz mal transcrito por el LLM vs. el `whatsapp_user_id`
--    verificado, o un widget web sin teléfono verificado), el INSERT crea
--    un contacto "fantasma" duplicado en vez de reconocer a la misma
--    persona — con su propio historial de leads/citas separado del real.
--
--    Se agrega resolución de identidad en dos pasos: primero por teléfono
--    (fuerte — el `ON CONFLICT` existente, sin cambios), y si no hay
--    coincidencia, por correo (más débil — reutiliza el índice
--    `idx_contacts_org_email` que ya existía sin consumidor). El teléfono
--    del contacto NUNCA se sobreescribe por una coincidencia de correo: la
--    fila encontrada conserva su identidad verificada, la conversación
--    nueva solo se vincula a `contact_id`. Riesgo aceptado y documentado:
--    un correo genérico/compartido (p. ej. "info@empresa.com" usado por dos
--    personas distintas) podría fusionar dos contactos reales — mitigado
--    porque el teléfono se intenta primero y la mayoría de conversaciones sí
--    lo traen.
-- =============================================================================

ALTER TABLE public.call_logs
    ADD COLUMN IF NOT EXISTS channel text;

COMMENT ON COLUMN public.call_logs.channel IS
    'Canal real de la conversación (voice/whatsapp/web/sms), mismo valor derivado que leads.channel (services/call-payload-mapper.ts deriveChannel()). Sin CHECK constraint: es un valor ya validado antes de llegar al RPC, igual que call_type/status en esta misma tabla.';

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
    -- 1. Resolución de identidad del contacto: teléfono primero (fuerte),
    --    correo después (débil, solo si el teléfono no encontró a nadie).
    --    El teléfono de una fila existente encontrada por correo nunca se
    --    toca — ver nota de riesgo aceptado arriba.
    IF p_caller_phone_e164 IS NOT NULL THEN
        SELECT id INTO v_contact_id
        FROM public.contacts
        WHERE organization_id = p_organization_id AND phone_e164 = p_caller_phone_e164;

        IF v_contact_id IS NULL AND p_email IS NOT NULL THEN
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
                last_seen_at = now()
            WHERE id = v_contact_id;
        ELSE
            INSERT INTO public.contacts (
                organization_id, phone_e164, full_name, email,
                business_name, business_sector, last_seen_at
            )
            VALUES (
                p_organization_id, p_caller_phone_e164, NULLIF(p_full_name, ''), NULLIF(p_email, ''),
                NULLIF(p_business_name, ''), NULLIF(p_business_sector, ''), now()
            )
            -- Red de seguridad ante una carrera real (dos llamadas
            -- concurrentes del mismo teléfono nuevo): el SELECT de arriba
            -- no bloquea la fila, así que dos ejecuciones simultáneas
            -- podrían intentar insertar el mismo phone_e164 a la vez.
            ON CONFLICT (organization_id, phone_e164) DO UPDATE SET
                full_name = COALESCE(public.contacts.full_name, EXCLUDED.full_name),
                email = COALESCE(public.contacts.email, EXCLUDED.email),
                business_name = COALESCE(public.contacts.business_name, EXCLUDED.business_name),
                business_sector = COALESCE(public.contacts.business_sector, EXCLUDED.business_sector),
                last_seen_at = now()
            RETURNING id INTO v_contact_id;
        END IF;
    END IF;

    -- 2. Upsert de call_logs por provider_call_id. Ahora también persiste
    --    `channel` (Punto 1 de esta migración).
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

    -- 3. Upsert de lead. Sin cambios respecto a la migración 19.
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
    'Persiste de forma atómica el resultado de una llamada: resuelve/crea el contacto por teléfono y, en su defecto, por correo (deduplicación cross-canal, migración 21), upsert de call_log (incluye channel, dirección de servicio y coordenadas geocodificadas), upsert de lead (DO UPDATE con COALESCE, fusiona la siembra de formulario de una llamada outbound con el webhook real que llega después) e inserción idempotente de usage_events. '
    'Ver Fase 2.2, Fase 3, docs/tasks/outbound-lead-persistence-and-rate-limit.md, la tarea de channel/LLM tokens/continuidad cross-canal, y las migraciones de dirección/geocoding y deduplicación de identidad.';
