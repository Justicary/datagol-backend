-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 40_fix_appointment_status_spanish.sql
-- =============================================================================
-- db/migrations/39_resultado_negocio.sql cambió appointments.status de texto
-- libre en inglés a un CHECK constraint con 6 valores en español
-- ('programada','confirmada','completada','no_asistio','cancelada',
-- 'reprogramada'). collect_planning_report_data (migración 36, Fase B de
-- docs/tasks/reportes-semanales.md) todavía comparaba contra el vocabulario
-- viejo en dos formas:
--
--   1. `a.status IS NULL` para detectar citas sin confirmar — con la 39,
--      status es NOT NULL DEFAULT 'programada', así que esa condición nunca
--      vuelve a ser cierta. El equivalente correcto es `status = 'programada'`
--      (39 lo documenta así: "programada = agendada sin confirmar").
--   2. `status IS DISTINCT FROM 'cancelled'` (x3, para excluir canceladas de
--      "contactos sin cita futura", "carga por día" y "huecos de agenda") —
--      el valor real ahora es 'cancelada', así que esas exclusiones dejaron
--      de aplicarse en silencio.
--
-- db/migrations/36_weekly_reports.sql en este repositorio YA tiene ambas
-- correcciones en su CREATE OR REPLACE FUNCTION — esta migración solo es
-- necesaria porque la 36 ya se había aplicado a la base viva ANTES de este
-- ajuste. CREATE OR REPLACE FUNCTION es seguro de re-ejecutar (no toca
-- políticas RLS ni tablas), a diferencia de re-correr el archivo 36 completo.
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
