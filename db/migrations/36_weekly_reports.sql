-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 36_weekly_reports.sql
-- =============================================================================
-- Reportes semanales (docs/tasks/reportes-semanales.md, Fase B): reporte de
-- planificación (lunes) y reporte ejecutivo (viernes), con datos calculados
-- en SQL y redactados por el LLM BYOK de la organización (Fase A).
--
-- 1. weekly_reports: hace doble función — restricción de idempotencia de B.1
--    (UNIQUE organization_id/report_type/week_start: "un reporte por
--    organización por semana por tipo") Y metadata de almacenamiento
--    descargable (storage_path en el bucket 'organization-reports'). Se
--    fusionan en una sola tabla en vez de una "scheduled_reports" aparte
--    porque son el mismo concepto: la fila EXISTE en cuanto se reclama el
--    slot semanal, sin importar cómo termine la generación.
--
-- 2. contact_pipeline_transitions + trigger: no existe ningún historial de
--    cambios de contacts.pipeline_stage en este repo (leads.pipeline_stage
--    fue renombrada a deprecated_pipeline_stage en la migración 25 — el
--    pipeline real vive en contacts). Sin esto, "cuántos avanzaron de etapa
--    esta semana" (B.2, reporte ejecutivo) no se puede calcular. El trigger
--    va en contacts, no en las funciones que la modifican
--    (advance_pipeline_on_lead, archive_stale_prospects): así captura
--    cualquier cambio presente o futuro sin tener que instrumentar cada
--    código que toca la columna.
--
-- 3. v_hot_leads_pending: vista mencionada como si ya existiera en el
--    comentario de src/jobs/send-prospect-summary.ts ("el email autoritativo
--    sigue el mismo COALESCE que la vista v_hot_leads_pending") pero nunca se
--    creó — se construye aquí con exactamente ese mismo COALESCE
--    (leads.email primero, contacts.email después).
--
-- 4. organizations_due_for_report(p_report_type): el scheduler de pg-boss
--    (src/jobs/sweep-weekly-reports.ts) corre cada 6 horas — pg_cron/pg-boss
--    no entienden zonas horarias por fila. Esta función NO compara
--    "EXTRACT(hour) = hora configurada" (eso solo dispara si el desfase UTC
--    de la organización es múltiplo exacto de 6h); en su lugar calcula el
--    instante exacto de la próxima ocurrencia local del (día, hora)
--    configurado y dispara si cae dentro de la ventana
--    (ahora_local - intervalo_de_sweep, ahora_local] — funciona sin importar
--    el offset o la hora elegida por el admin.
--
--    NO filtra por feature habilitada (organization_enabled_features): el
--    trabajador por organización (generate-weekly-report.ts) hace esa
--    verificación justo antes de generar, siguiendo AGENTS.md §16 ("verificar
--    la feature antes de ejecutar el efecto, no antes de encolar") — el
--    firmado exacto de retorno de esa función RPC no se pudo confirmar contra
--    la base real desde este entorno de desarrollo, así que se prefiere no
--    apostar una migración a un supuesto no verificado.
--
-- 5. collect_planning_report_data / collect_executive_report_data: todo el
--    cómputo numérico vive aquí — el LLM (B.3) solo redacta sobre el
--    resultado, nunca calcula. Límites de datos documentados explícitamente
--    donde el modelo de datos actual no alcanza:
--      - "Concurrencia rebasada" queda FUERA de las alertas del reporte
--        ejecutivo: call_logs solo tiene created_at + duration_seconds, no
--        un intervalo real de inicio/fin de llamada, así que cualquier
--        cálculo de solapamiento con esta tabla se vería preciso sin serlo.
--      - "Credencial por vencer" se sustituye por "credencial de LLM con
--        error de validación" (integration_settings.llm.lastError, Fase A) —
--        no existe ningún campo de expiración de credenciales en el esquema.
--      - "Temas recurrentes" agrupa leads.inquiry_reason por texto exacto
--        normalizado (conteo real de SQL), no por clustering semántico —
--        eso necesitaría el pipeline de embeddings de rag.ts, fuera de
--        alcance de esta fase.
--      - "Huecos en la agenda" solo se calcula si
--        integration_settings.business_hours existe (forma asumida
--        {mon:"09:00-18:00", ...} — no hay un schema validado para esa clave
--        todavía); si no existe, la sección se omite en vez de inventar un
--        horario. Es un cálculo de MINUTOS de capacidad libre por día
--        (horas de atención menos horas ya agendadas), no una enumeración de
--        huecos exactos entre citas — eso requeriría asumir una duración
--        estándar de servicio que tampoco está modelada.
--    Todas las comparaciones de fecha usan organizations.timezone (Fase A)
--    para que los límites de "esta semana" respeten el calendario local de
--    la organización, no el huso horario del servidor.
--
-- 6. features / plan_features: siembra 'weekly_planning_report' y
--    'weekly_executive_report' (categoría 'operacion', requires_provider
--    NULL — la llave es del cliente) asignadas a pro/elite/enterprise (B.5).
--    La guarda adicional de "llm_api_key presente y validada" vive en
--    código (llm-config-service.ts / entitlements.ts), no aquí: no hay forma
--    de expresar "validatedAt no nulo Y sin lastError más reciente" como un
--    CHECK constraint declarativo sin acoplar esta tabla a la forma interna
--    de integration_settings.llm.
-- =============================================================================

-- =============================================================================
-- BLOQUE 1 — weekly_reports
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.weekly_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    report_type text NOT NULL CHECK (report_type IN ('planning', 'executive')),
    week_start date NOT NULL,
    status text NOT NULL CHECK (status IN ('generating', 'generated', 'narrative_fallback', 'skipped_no_activity', 'failed')),
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    narrative text,
    storage_path text,
    file_size_bytes int,
    delivery_log jsonb NOT NULL DEFAULT '{}'::jsonb,
    error text,
    generated_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, report_type, week_start)
);

CREATE INDEX IF NOT EXISTS idx_weekly_reports_org_created
    ON public.weekly_reports (organization_id, created_at DESC);

ALTER TABLE public.weekly_reports ENABLE ROW LEVEL SECURITY;

-- Solo lectura para miembros — la escritura es siempre service_role desde el
-- job (mismo patrón de "RLS habilitada, sin política de escritura" que
-- organization_usage_alerts, migración 31, salvo que aquí sí se expone
-- lectura al tenant).
CREATE POLICY tenant_read ON public.weekly_reports
    FOR SELECT
    USING (organization_id IN (SELECT auth_active_organization_ids()));

COMMENT ON TABLE public.weekly_reports IS
    'Reportes semanales generados (planificación/ejecutivo). Fila de idempotencia (UNIQUE organization_id/report_type/week_start) y metadata de descarga (storage_path en el bucket organization-reports) a la vez.';

-- =============================================================================
-- BLOQUE 2 — contact_pipeline_transitions
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.contact_pipeline_transitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    from_stage text,
    to_stage text NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_pipeline_transitions_org_changed
    ON public.contact_pipeline_transitions (organization_id, changed_at DESC);

ALTER TABLE public.contact_pipeline_transitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON public.contact_pipeline_transitions
    FOR SELECT
    USING (organization_id IN (SELECT auth_active_organization_ids()));

COMMENT ON TABLE public.contact_pipeline_transitions IS
    'Historial de cambios de contacts.pipeline_stage, capturado por trigger. Alimenta "movimiento de pipeline" del reporte ejecutivo semanal.';

CREATE OR REPLACE FUNCTION public.log_pipeline_stage_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.contact_pipeline_transitions (organization_id, contact_id, from_stage, to_stage)
    VALUES (NEW.organization_id, NEW.id, OLD.pipeline_stage, NEW.pipeline_stage);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_pipeline_stage_transition ON public.contacts;
CREATE TRIGGER trg_log_pipeline_stage_transition
    AFTER UPDATE OF pipeline_stage ON public.contacts
    FOR EACH ROW
    WHEN (OLD.pipeline_stage IS DISTINCT FROM NEW.pipeline_stage)
    EXECUTE FUNCTION public.log_pipeline_stage_transition();

-- =============================================================================
-- BLOQUE 3 — v_hot_leads_pending
-- =============================================================================
DROP VIEW IF EXISTS public.v_hot_leads_pending;
CREATE OR REPLACE VIEW public.v_hot_leads_pending
WITH (security_invoker = true) AS
SELECT
    l.id AS lead_id,
    l.organization_id,
    l.contact_id,
    COALESCE(l.full_name, c.full_name) AS full_name,
    COALESCE(l.email, c.email) AS email,
    COALESCE(l.contact_phone, c.phone_e164) AS phone_e164,
    l.business_name,
    l.inquiry_reason,
    l.temperature,
    l.followup_status,
    l.followup_notes,
    l.channel,
    l.created_at
FROM public.leads l
LEFT JOIN public.contacts c ON c.id = l.contact_id
WHERE l.temperature = 'caliente'
  AND l.followup_status = 'pendiente'
  AND COALESCE(c.opted_out, false) = false;

-- =============================================================================
-- BLOQUE 4 — organizations_due_for_report
-- =============================================================================

CREATE OR REPLACE FUNCTION public.organizations_due_for_report(
    p_report_type text,
    p_sweep_interval interval DEFAULT interval '6 hours',
    p_now timestamptz DEFAULT now()
)
RETURNS TABLE(organization_id uuid, week_start date)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT o.id, (date_trunc('week', t.local_now))::date AS week_start
    FROM public.organizations o
    CROSS JOIN LATERAL (
        SELECT (p_now AT TIME ZONE o.timezone) AS local_now
    ) t
    CROSS JOIN LATERAL (
        SELECT
            COALESCE((o.integration_settings #>> ARRAY['reports', p_report_type, 'enabled'])::boolean, true) AS enabled,
            COALESCE(
                (o.integration_settings #>> ARRAY['reports', p_report_type, 'dayOfWeek'])::int,
                CASE p_report_type WHEN 'planning' THEN 1 WHEN 'executive' THEN 5 END
            ) AS day_of_week,
            COALESCE(
                (o.integration_settings #>> ARRAY['reports', p_report_type, 'hour'])::int,
                CASE p_report_type WHEN 'planning' THEN 6 WHEN 'executive' THEN 18 END
            ) AS hour
    ) cfg
    CROSS JOIN LATERAL (
        -- date_trunc('week', ts) da el lunes 00:00 de esa semana ISO.
        -- ((day_of_week + 6) % 7) convierte la convención EXTRACT(dow)
        -- (0=domingo..6=sábado) al desfase en días desde ese lunes.
        SELECT date_trunc('week', t.local_now)
             + (((cfg.day_of_week + 6) % 7)) * interval '1 day'
             + cfg.hour * interval '1 hour' AS target_local
    ) tgt
    WHERE cfg.enabled
      AND tgt.target_local <= t.local_now
      AND tgt.target_local > (t.local_now - p_sweep_interval)
      AND NOT EXISTS (
          SELECT 1 FROM public.weekly_reports wr
          WHERE wr.organization_id = o.id
            AND wr.report_type = p_report_type
            AND wr.week_start = (date_trunc('week', t.local_now))::date
      );
END;
$$;

COMMENT ON FUNCTION public.organizations_due_for_report IS
    'Organizaciones cuyo (día, hora) local configurado para el reporte cae dentro de la ventana de sweep actual, y que todavía no tienen weekly_reports para esa semana. p_sweep_interval debe coincidir con la frecuencia real del cron de src/jobs/sweep-weekly-reports.ts.';

-- =============================================================================
-- BLOQUE 5 — collect_planning_report_data
-- =============================================================================

CREATE OR REPLACE FUNCTION public.collect_planning_report_data(
    p_organization_id uuid,
    p_week_start date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tz text;
    v_week_start_ts timestamptz;
    v_week_end_ts timestamptz;
    v_business_hours jsonb;
    v_appointments_by_day jsonb;
    v_unconfirmed jsonb;
    v_hot_leads jsonb;
    v_overdue_followups jsonb;
    v_stalled_contacts jsonb;
    v_daily_load jsonb;
    v_agenda_gaps jsonb;
BEGIN
    SELECT COALESCE(timezone, 'America/Mexico_City'), integration_settings -> 'business_hours'
      INTO v_tz, v_business_hours
      FROM public.organizations WHERE id = p_organization_id;

    v_week_start_ts := (p_week_start::timestamp) AT TIME ZONE v_tz;
    v_week_end_ts := ((p_week_start + 7)::timestamp) AT TIME ZONE v_tz;

    SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.start_time), '[]'::jsonb) INTO v_appointments_by_day
    FROM (
        SELECT a.id, a.customer_name, a.start_time, a.status,
               (a.start_time AT TIME ZONE v_tz)::date AS local_day
        FROM public.appointments a
        WHERE a.organization_id = p_organization_id
          AND a.start_time >= v_week_start_ts AND a.start_time < v_week_end_ts
    ) x;

    SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.start_time), '[]'::jsonb) INTO v_unconfirmed
    FROM (
        SELECT a.id, a.customer_name, a.start_time
        FROM public.appointments a
        WHERE a.organization_id = p_organization_id
          AND a.start_time >= v_week_start_ts AND a.start_time < v_week_end_ts
          AND a.status = 'programada'
    ) x;

    SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.created_at), '[]'::jsonb) INTO v_hot_leads
    FROM (
        SELECT lead_id, full_name, phone_e164, business_name, inquiry_reason, created_at
        FROM public.v_hot_leads_pending
        WHERE organization_id = p_organization_id
    ) x;

    SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.followup_at), '[]'::jsonb) INTO v_overdue_followups
    FROM (
        SELECT id AS lead_id, full_name, contact_phone, followup_notes, followup_at
        FROM public.leads
        WHERE organization_id = p_organization_id
          AND followup_status = 'pendiente'
          AND followup_at IS NOT NULL
          AND followup_at < now()
    ) x;

    SELECT COALESCE(jsonb_agg(row_to_json(x)), '[]'::jsonb) INTO v_stalled_contacts
    FROM (
        SELECT c.id AS contact_id, c.full_name, c.phone_e164
        FROM public.contacts c
        WHERE c.organization_id = p_organization_id
          AND c.pipeline_stage = 'cita_agendada'
          AND c.archived_at IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM public.appointments ap
              WHERE ap.contact_id = c.id
                AND ap.start_time > now()
                AND ap.status IS DISTINCT FROM 'cancelada'
          )
    ) x;

    -- Carga por día: incluye TODOS los días de la semana (generate_series),
    -- no solo los que tuvieron citas — de lo contrario un día vacío
    -- desaparecería del reporte en vez de mostrarse como vacío.
    SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.day), '[]'::jsonb) INTO v_daily_load
    FROM (
        SELECT d::date AS day,
               COALESCE(c.appointment_count, 0) AS appointment_count,
               COALESCE(c.appointment_count, 0) > (AVG(COALESCE(c.appointment_count, 0)) OVER () * 1.5) AS is_high_load
        FROM generate_series(v_week_start_ts, v_week_end_ts - interval '1 day', interval '1 day') d
        LEFT JOIN LATERAL (
            SELECT COUNT(*) AS appointment_count
            FROM public.appointments a
            WHERE a.organization_id = p_organization_id
              AND (a.start_time AT TIME ZONE v_tz)::date = (d AT TIME ZONE v_tz)::date
              AND a.status IS DISTINCT FROM 'cancelada'
        ) c ON true
    ) x;

    -- Huecos de agenda: minutos de capacidad libre por día, solo si
    -- business_hours está configurado (ver nota del encabezado). No es una
    -- lista de huecos exactos entre citas.
    IF v_business_hours IS NOT NULL AND jsonb_typeof(v_business_hours) = 'object' THEN
        SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.day), '[]'::jsonb) INTO v_agenda_gaps
        FROM (
            SELECT
                (d AT TIME ZONE v_tz)::date AS day,
                bhm.bh_minutes,
                GREATEST(bhm.bh_minutes - COALESCE(booked.booked_minutes, 0), 0) AS free_minutes
            FROM generate_series(v_week_start_ts, v_week_end_ts - interval '1 day', interval '1 day') d
            CROSS JOIN LATERAL (
                SELECT v_business_hours ->> (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[EXTRACT(dow FROM (d AT TIME ZONE v_tz))::int + 1] AS hours_text
            ) bh
            CROSS JOIN LATERAL (
                SELECT CASE
                    WHEN bh.hours_text ~ '^[0-9]{2}:[0-9]{2}-[0-9]{2}:[0-9]{2}$' THEN
                        (EXTRACT(EPOCH FROM (
                            split_part(bh.hours_text, '-', 2)::time - split_part(bh.hours_text, '-', 1)::time
                        )) / 60)::int
                    ELSE NULL
                END AS bh_minutes
            ) bhm
            LEFT JOIN LATERAL (
                SELECT SUM(EXTRACT(EPOCH FROM (a.end_time - a.start_time)) / 60)::int AS booked_minutes
                FROM public.appointments a
                WHERE a.organization_id = p_organization_id
                  AND (a.start_time AT TIME ZONE v_tz)::date = (d AT TIME ZONE v_tz)::date
                  AND a.status IS DISTINCT FROM 'cancelada'
            ) booked ON true
            WHERE bhm.bh_minutes IS NOT NULL
        ) x;
    ELSE
        v_agenda_gaps := NULL;
    END IF;

    RETURN jsonb_build_object(
        'weekStart', p_week_start,
        'weekEnd', (p_week_start + 6),
        'appointmentsByDay', v_appointments_by_day,
        'unconfirmedAppointments', v_unconfirmed,
        'hotLeadsPending', v_hot_leads,
        'overdueFollowups', v_overdue_followups,
        'stalledContacts', v_stalled_contacts,
        'dailyLoad', v_daily_load,
        'agendaGapsMinutes', v_agenda_gaps
    );
END;
$$;

-- =============================================================================
-- BLOQUE 6 — collect_executive_report_data
-- =============================================================================

CREATE OR REPLACE FUNCTION public.collect_executive_report_data(
    p_organization_id uuid,
    p_week_start date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tz text;
    v_week_start_ts timestamptz;
    v_week_end_ts timestamptz;
    v_prev_week_start_ts timestamptz;
    v_totals jsonb;
    v_by_channel jsonb;
    v_lost jsonb;
    v_pipeline_movement jsonb;
    v_recurring_topics jsonb;
    v_cost jsonb;
    v_alerts jsonb;
BEGIN
    SELECT COALESCE(timezone, 'America/Mexico_City') INTO v_tz
      FROM public.organizations WHERE id = p_organization_id;

    v_week_start_ts := (p_week_start::timestamp) AT TIME ZONE v_tz;
    v_week_end_ts := ((p_week_start + 7)::timestamp) AT TIME ZONE v_tz;
    v_prev_week_start_ts := ((p_week_start - 7)::timestamp) AT TIME ZONE v_tz;

    WITH current_week AS (
        SELECT COUNT(*) AS conversations, COUNT(*) FILTER (WHERE booked_appointment) AS appointments_booked
        FROM public.leads
        WHERE organization_id = p_organization_id
          AND created_at >= v_week_start_ts AND created_at < v_week_end_ts
    ),
    previous_week AS (
        SELECT COUNT(*) AS conversations, COUNT(*) FILTER (WHERE booked_appointment) AS appointments_booked
        FROM public.leads
        WHERE organization_id = p_organization_id
          AND created_at >= v_prev_week_start_ts AND created_at < v_week_start_ts
    )
    SELECT jsonb_build_object(
        'conversations', jsonb_build_object('current', cw.conversations, 'previous', pw.conversations),
        'appointmentsBooked', jsonb_build_object('current', cw.appointments_booked, 'previous', pw.appointments_booked)
    ) INTO v_totals
    FROM current_week cw, previous_week pw;

    SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.total DESC), '[]'::jsonb) INTO v_by_channel
    FROM (
        SELECT channel,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE booked_appointment) AS booked,
               ROUND((COUNT(*) FILTER (WHERE booked_appointment))::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS conversion_rate_pct
        FROM public.leads
        WHERE organization_id = p_organization_id
          AND created_at >= v_week_start_ts AND created_at < v_week_end_ts
        GROUP BY channel
    ) x;

    SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.total DESC), '[]'::jsonb) INTO v_lost
    FROM (
        SELECT lost_reason, COUNT(*) AS total
        FROM public.contacts
        WHERE organization_id = p_organization_id
          AND pipeline_stage = 'perdido'
          AND lost_reason IS NOT NULL
          AND pipeline_updated_at >= v_week_start_ts AND pipeline_updated_at < v_week_end_ts
        GROUP BY lost_reason
    ) x;

    SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.total DESC), '[]'::jsonb) INTO v_pipeline_movement
    FROM (
        SELECT from_stage, to_stage, COUNT(*) AS total
        FROM public.contact_pipeline_transitions
        WHERE organization_id = p_organization_id
          AND changed_at >= v_week_start_ts AND changed_at < v_week_end_ts
        GROUP BY from_stage, to_stage
    ) x;

    -- Agrupación exacta de texto, no clustering semántico — ver nota del encabezado.
    SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.total DESC), '[]'::jsonb) INTO v_recurring_topics
    FROM (
        SELECT lower(trim(inquiry_reason)) AS topic, COUNT(*) AS total
        FROM public.leads
        WHERE organization_id = p_organization_id
          AND created_at >= v_week_start_ts AND created_at < v_week_end_ts
          AND inquiry_reason IS NOT NULL AND trim(inquiry_reason) <> ''
        GROUP BY lower(trim(inquiry_reason))
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 5
    ) x;

    SELECT jsonb_build_object(
        'totalUsd', ROUND(COALESCE(SUM(COALESCE(amount_usd, unit_rate_usd * quantity)), 0)::numeric, 4),
        'perProspectUsd', ROUND(
            COALESCE(SUM(COALESCE(amount_usd, unit_rate_usd * quantity)), 0)
            / NULLIF((SELECT COUNT(*) FROM public.leads WHERE organization_id = p_organization_id AND created_at >= v_week_start_ts AND created_at < v_week_end_ts), 0)
        ::numeric, 4)
    ) INTO v_cost
    FROM public.usage_events
    WHERE organization_id = p_organization_id
      AND occurred_at >= v_week_start_ts AND occurred_at < v_week_end_ts;

    -- Alertas: sin "concurrencia rebasada" (ver nota del encabezado — el
    -- modelo de datos de call_logs no sostiene ese cálculo).
    WITH current_avg AS (
        SELECT AVG(duration_seconds) AS avg_dur
        FROM public.call_logs
        WHERE organization_id = p_organization_id
          AND created_at >= v_week_start_ts AND created_at < v_week_end_ts
          AND duration_seconds IS NOT NULL
    ),
    baseline_avg AS (
        SELECT AVG(duration_seconds) AS avg_dur
        FROM public.call_logs
        WHERE organization_id = p_organization_id
          AND created_at >= (v_week_start_ts - interval '28 days') AND created_at < v_week_start_ts
          AND duration_seconds IS NOT NULL
    )
    SELECT jsonb_build_object(
        'avgCallDurationSeconds', ROUND(ca.avg_dur::numeric, 0),
        'baselineAvgCallDurationSeconds', ROUND(ba.avg_dur::numeric, 0),
        'isDurationAnomalous', ba.avg_dur IS NOT NULL AND ca.avg_dur IS NOT NULL AND ABS(ca.avg_dur - ba.avg_dur) > (ba.avg_dur * 0.3),
        'llmCredentialError', (SELECT integration_settings #>> ARRAY['llm', 'lastError'] FROM public.organizations WHERE id = p_organization_id)
    ) INTO v_alerts
    FROM current_avg ca, baseline_avg ba;

    RETURN jsonb_build_object(
        'weekStart', p_week_start,
        'weekEnd', (p_week_start + 6),
        'totals', v_totals,
        'byChannel', v_by_channel,
        'lostProspects', v_lost,
        'pipelineMovement', v_pipeline_movement,
        'recurringTopics', v_recurring_topics,
        'costUsd', v_cost,
        'alerts', v_alerts
    );
END;
$$;

-- =============================================================================
-- BLOQUE 7 — Semilla de features
-- =============================================================================

INSERT INTO public.features (key, name, description, category, requires_provider, has_cost_impact, globally_disabled, sort_order)
VALUES
    ('weekly_planning_report', 'Reporte semanal de planificación',
     'Reporte de lunes con citas de la semana, prospectos calientes sin atender, seguimientos vencidos y huecos de agenda. Requiere llave BYOK de LLM validada.',
     'operacion', NULL, false, false, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM public.features)),
    ('weekly_executive_report', 'Reporte semanal ejecutivo',
     'Reporte de viernes con variación semana contra semana, conversión por canal, costos, prospectos perdidos y recomendaciones. Requiere llave BYOK de LLM validada.',
     'operacion', NULL, false, false, (SELECT COALESCE(MAX(sort_order), 0) + 2 FROM public.features))
ON CONFLICT (key) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    category = EXCLUDED.category;

INSERT INTO public.plan_features (plan_key, feature_key, enabled)
VALUES
    ('pro', 'weekly_planning_report', true),
    ('pro', 'weekly_executive_report', true),
    ('elite', 'weekly_planning_report', true),
    ('elite', 'weekly_executive_report', true),
    ('enterprise', 'weekly_planning_report', true),
    ('enterprise', 'weekly_executive_report', true)
ON CONFLICT (plan_key, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled;
