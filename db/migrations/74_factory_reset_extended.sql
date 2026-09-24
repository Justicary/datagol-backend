-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 74_factory_reset_extended.sql
-- =============================================================================
-- Amplía `factory_reset_transactional_data()` (migraciones 23 y 30, ya
-- aplicadas; no se tocan) para que el "restaurar valores de fábrica" no deje
-- basura de pruebas ni filas huérfanas, y corrige un borrado excesivo.
--
-- 1. CORRECCIÓN — `contact_addresses`: la migración 30 borraba TODAS las
--    direcciones. Desde la migración 33, `contact_id IS NULL` representa las
--    sucursales/matriz de la PROPIA organización (configuración que usa el
--    agente en routes/tools/locations.ts). Ahora solo se borran las de
--    contactos (`contact_id IS NOT NULL`).
--
-- 2. HUÉRFANAS — `SET LOCAL session_replication_role = replica` desactiva los
--    triggers Y la aplicación de las FK, así que al borrar contacts/leads/
--    call_logs/appointments NO se ejecutaba ningún ON DELETE CASCADE/SET NULL.
--    Quedaban apuntando a IDs inexistentes:
--      contact_pipeline_transitions (contact_id NOT NULL, migración 36)
--      thank_you_sends              (contact_id NOT NULL, lead_id; migración 34)
--      whatsapp_messages            (contact_id NOT NULL)
--      email_outbox                 (contact_id; migración 53)
--      appointment_waitlist         (contact_id, call_log_id, offered_appointment_id; migración 64)
--    Se vacían por completo.
--
-- 3. HISTORIAL DE PRUEBAS sin valor de configuración, también se vacía:
--      unanswered_questions, weekly_reports, competitor_site_snapshots,
--      outbound_call_attempts, organization_usage_alerts,
--      concurrency_quota_alerts, permission_audit_log (hermana de
--      feature_audit_log, que ya se vaciaba), catalog_imports, y las
--      organization_invitations aceptadas, revocadas o vencidas (las
--      PENDIENTES se conservan).
--    Los archivos de `weekly_reports` en el bucket `organization-reports` los
--    borra la ruta (routes/admin/factory-reset.ts) DESPUÉS de esta función:
--    Storage no participa de la transacción.
--
-- Se conserva intacto (configuración, infraestructura y facturación):
--   organizations, credential_groups, organization_secrets, plans, features,
--   plan_features, organization_features, usage_events (solo se limpia
--   call_log_id colgante, igual que antes), webhook_events,
--   organization_members, organization_role_permissions, email_accounts,
--   organization_attachments, competitor_sites, knowledge_base, catálogos y
--   productos, organization_concurrency_quota, catálogos del sistema y
--   tablas del plano de control.
--
-- Mismo mecanismo que la versión anterior (ver comentario de la migración
-- 23): DELETE con `WHERE` (compatibilidad con safeupdate), dentro de
-- `session_replication_role = replica` para poder vaciar tablas append-only
-- (contact_notes, feature_audit_log, permission_audit_log) y limpiar
-- usage_events.call_log_id. Orden: hojas → padres.
--
-- El JSON devuelto conserva las 5 claves anteriores y agrega una por tabla.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.factory_reset_transactional_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_counts jsonb := '{}'::jsonb;
    v_rows integer;
BEGIN
    SET LOCAL session_replication_role = replica;

    -- Referencia colgante de facturación (sin tocar importes). Ver migración 23.
    UPDATE public.usage_events SET call_log_id = NULL WHERE call_log_id IS NOT NULL;

    -- Hijas de contacts/leads/call_logs/appointments (antes quedaban huérfanas).
    DELETE FROM public.thank_you_sends WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('thank_you_sends_deleted', v_rows);

    DELETE FROM public.whatsapp_messages WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('whatsapp_messages_deleted', v_rows);

    DELETE FROM public.email_outbox WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('email_outbox_deleted', v_rows);

    DELETE FROM public.contact_pipeline_transitions WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('contact_pipeline_transitions_deleted', v_rows);

    DELETE FROM public.appointment_waitlist WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('appointment_waitlist_deleted', v_rows);

    -- Núcleo transaccional (igual que antes).
    DELETE FROM public.appointments WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('appointments_deleted', v_rows);

    DELETE FROM public.leads WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('leads_deleted', v_rows);

    DELETE FROM public.call_logs WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('call_logs_deleted', v_rows);

    DELETE FROM public.contact_notes WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('contact_notes_deleted', v_rows);

    -- Solo direcciones de contactos: las de la organización (contact_id NULL) son configuración.
    DELETE FROM public.contact_addresses WHERE contact_id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('contact_addresses_deleted', v_rows);

    DELETE FROM public.contacts WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('contacts_deleted', v_rows);

    -- Bitácoras de auditoría (ambas append-only; replica desactiva su trigger).
    DELETE FROM public.feature_audit_log WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('feature_audit_log_deleted', v_rows);

    DELETE FROM public.permission_audit_log WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('permission_audit_log_deleted', v_rows);

    -- Historial de pruebas sin valor de configuración.
    DELETE FROM public.unanswered_questions WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('unanswered_questions_deleted', v_rows);

    DELETE FROM public.weekly_reports WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('weekly_reports_deleted', v_rows);

    DELETE FROM public.competitor_site_snapshots WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('competitor_site_snapshots_deleted', v_rows);

    DELETE FROM public.outbound_call_attempts WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('outbound_call_attempts_deleted', v_rows);

    DELETE FROM public.organization_usage_alerts WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('organization_usage_alerts_deleted', v_rows);

    DELETE FROM public.concurrency_quota_alerts WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('concurrency_quota_alerts_deleted', v_rows);

    DELETE FROM public.catalog_imports WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('catalog_imports_deleted', v_rows);

    -- Invitaciones: se conservan las pendientes (no aceptadas, no revocadas, vigentes).
    DELETE FROM public.organization_invitations
    WHERE accepted_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= now();
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('organization_invitations_deleted', v_rows);

    SET LOCAL session_replication_role = DEFAULT;

    RETURN v_counts;
END;
$$;

COMMENT ON FUNCTION public.factory_reset_transactional_data IS
    'Restaurar valores de fábrica (migración 74): vacía datos transaccionales y de pruebas (contactos, leads, llamadas, citas y sus tablas hijas, bitácoras de auditoría, reportes, snapshots, alertas, intentos salientes, importaciones de catálogo, invitaciones no pendientes). Conserva configuración, direcciones de la organización (contact_id NULL), usage_events y webhook_events. Invocada solo desde POST /api/admin/factory-reset (isPlatformAdmin + frase de confirmación). Irreversible.';
