-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Purga automática de contenido con datos personales pasado
-- `organizations.retention_days` (migración 16). El pendiente con exposición
-- legal real de esta sesión: transcripciones completas de personas reales
-- sin plazo de purga.
--
-- Qué se purga (contenido) vs. qué se conserva (fila + negocio):
--   - call_logs.transcript / call_logs.summary → NULL. duration_seconds,
--     cost, sentiment, status, timestamps: se conservan (metering y
--     reportes de calidad no dependen del texto).
--   - webhook_events.raw_payload → redactado a un marcador mínimo (mismo
--     patrón que el borrado ARCO de la migración 17): el body crudo trae el
--     mismo transcript y los mismos data_collection_results (nombre/correo/
--     teléfono) que call_logs/leads, purgar uno y dejar el otro intacto para
--     siempre sería letra sin fondo.
--   - leads, contacts, usage_events: NUNCA tocados por este job — la fila
--     del lead y su metering se conservan siempre, como pidió el usuario.
--     `leads.full_name`/`email`/`contact_phone` solo se borran vía ARCO
--     explícito (migración 17), nunca por plazo — el nombre de un prospecto
--     no es, por sí solo, el mismo nivel de riesgo que su transcripción
--     completa, y borrarlo automáticamente rompería reportes de negocio que
--     si tienen un motivo legítimo de conservarse más allá del plazo de
--     contenido conversacional.
--
-- WHERE ... IS NOT NULL en ambas UPDATE: evita reescribir filas ya purgadas
-- en cada corrida diaria (el job es idempotente por diseño — reintentarlo no
-- tiene efecto sobre lo ya purgado, y no cuesta un UPDATE de las mismas
-- filas cada día indefinidamente).
--
-- pg_cron: si `CREATE EXTENSION pg_cron` falla en tu proyecto de Supabase
-- (algunos planes no lo incluyen), la alternativa ya contemplada en
-- AGENTS.md §8 es un job recurrente de pg-boss
-- (`fastify.pgBoss.schedule(...)`) que llame al mismo
-- `public.purge_expired_call_content()` — la función SQL no depende de
-- pg_cron en sí, solo el disparador diario.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.purge_expired_call_content()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_call_logs_purged integer;
    v_webhook_events_purged integer;
BEGIN
    UPDATE public.call_logs cl
    SET transcript = NULL,
        summary = NULL
    FROM public.organizations o
    WHERE cl.organization_id = o.id
      AND (cl.transcript IS NOT NULL OR cl.summary IS NOT NULL)
      AND cl.created_at < now() - (o.retention_days || ' days')::interval;
    GET DIAGNOSTICS v_call_logs_purged = ROW_COUNT;

    UPDATE public.webhook_events we
    SET raw_payload = jsonb_build_object(
        'purged', true,
        'purged_at', now(),
        'purged_reason', 'retention_expired',
        'event_type', we.event_type
    )
    FROM public.organizations o
    WHERE we.organization_id = o.id
      AND NOT COALESCE((we.raw_payload ->> 'purged')::boolean, false)
      AND we.received_at < now() - (o.retention_days || ' days')::interval;
    GET DIAGNOSTICS v_webhook_events_purged = ROW_COUNT;

    RETURN jsonb_build_object(
        'call_logs_purged', v_call_logs_purged,
        'webhook_events_purged', v_webhook_events_purged,
        'ran_at', now()
    );
END;
$$;

COMMENT ON FUNCTION public.purge_expired_call_content() IS
    'Job diario de retención: purga call_logs.transcript/summary y redacta '
    'webhook_events.raw_payload para filas más viejas que '
    'organizations.retention_days. Nunca toca leads/contacts/usage_events — '
    'la fila y el metering se conservan siempre. Idempotente (WHERE ... IS '
    'NOT NULL / NOT purged evita retrabajo). Programado vía pg_cron, ver '
    'cron.schedule abajo.';

-- Diario 03:00 UTC — fuera de horario laboral en México (UTC-6), ventana de
-- bajo tráfico. unschedule primero para que reaplicar esta migración no
-- duplique el job (cron.schedule con el mismo nombre no es idempotente por
-- sí solo en todas las versiones de pg_cron).
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'purge-expired-call-content';

SELECT cron.schedule(
    'purge-expired-call-content',
    '0 3 * * *',
    $$SELECT public.purge_expired_call_content();$$
);
