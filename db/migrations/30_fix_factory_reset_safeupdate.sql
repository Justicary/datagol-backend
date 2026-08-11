-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Actualiza `factory_reset_transactional_data()` agregando cláusulas `WHERE id IS NOT NULL`
-- a cada sentencia `DELETE FROM`. Esto resuelve el error "DELETE requires a WHERE clause"
-- generado por la extensión / parámetro `safeupdate` de PostgreSQL cuando se intentan
-- ejecutar sentencias DELETE globales en la base de datos.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.factory_reset_transactional_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_appointments_deleted integer;
    v_leads_deleted integer;
    v_call_logs_deleted integer;
    v_contacts_deleted integer;
    v_feature_audit_log_deleted integer;
BEGIN
    SET LOCAL session_replication_role = replica;

    -- Limpia la referencia colgante ANTES de borrar call_logs.
    UPDATE public.usage_events SET call_log_id = NULL WHERE call_log_id IS NOT NULL;

    DELETE FROM public.appointments WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_appointments_deleted = ROW_COUNT;

    DELETE FROM public.leads WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_leads_deleted = ROW_COUNT;

    DELETE FROM public.call_logs WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_call_logs_deleted = ROW_COUNT;

    -- Limpieza explícita de notas y direcciones de contacto antes de contacts
    DELETE FROM public.contact_notes WHERE id IS NOT NULL;
    DELETE FROM public.contact_addresses WHERE id IS NOT NULL;

    DELETE FROM public.contacts WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_contacts_deleted = ROW_COUNT;

    DELETE FROM public.feature_audit_log WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_feature_audit_log_deleted = ROW_COUNT;

    SET LOCAL session_replication_role = DEFAULT;

    RETURN jsonb_build_object(
        'appointments_deleted', v_appointments_deleted,
        'leads_deleted', v_leads_deleted,
        'call_logs_deleted', v_call_logs_deleted,
        'contacts_deleted', v_contacts_deleted,
        'feature_audit_log_deleted', v_feature_audit_log_deleted
    );
END;
$$;

COMMENT ON FUNCTION public.factory_reset_transactional_data IS
    'Vacía appointments/call_logs/contacts/feature_audit_log/leads por completo. Incluye cláusulas WHERE id IS NOT NULL para compatibilidad con safeupdate de PostgreSQL.';
