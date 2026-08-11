-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Función administrativa para eliminación en cascada de organizaciones.
-- `usage_events`, `contact_notes` y `feature_audit_log` tienen triggers BEFORE
-- DELETE OR UPDATE que rechazan mutaciones ("usage_events es append-only").
-- `SET LOCAL session_replication_role = replica` desactiva temporalmente los
-- triggers dentro de esta transacción para permitir que un Platform Admin
-- elimine permanentemente la organización y toda su información asociada.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_delete_organizations_cascade(p_organization_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deleted_count integer;
    v_deleted_ids uuid[];
BEGIN
    -- Desactivar triggers (incluyendo los triggers append-only) localmente en esta transacción
    SET LOCAL session_replication_role = replica;

    -- Obtener lista de IDs que realmente existen antes de borrar
    SELECT array_agg(id) INTO v_deleted_ids
    FROM public.organizations
    WHERE id = ANY(p_organization_ids);

    IF v_deleted_ids IS NULL THEN
        v_deleted_ids := ARRAY[]::uuid[];
    END IF;

    -- Borrado explícito de tablas dependientes para garantizar limpieza sin huérfanos
    DELETE FROM public.appointments WHERE organization_id = ANY(p_organization_ids);
    DELETE FROM public.leads WHERE organization_id = ANY(p_organization_ids);
    DELETE FROM public.call_logs WHERE organization_id = ANY(p_organization_ids);
    DELETE FROM public.contact_notes WHERE organization_id = ANY(p_organization_ids);
    DELETE FROM public.contacts WHERE organization_id = ANY(p_organization_ids);
    DELETE FROM public.contact_addresses WHERE organization_id = ANY(p_organization_ids);
    DELETE FROM public.feature_audit_log WHERE organization_id = ANY(p_organization_ids);
    DELETE FROM public.usage_events WHERE organization_id = ANY(p_organization_ids);
    DELETE FROM public.webhook_events WHERE organization_id = ANY(p_organization_ids);
    DELETE FROM public.organization_secrets WHERE organization_id = ANY(p_organization_ids);
    DELETE FROM public.organization_members WHERE organization_id = ANY(p_organization_ids);

    -- Borrar organizaciones
    DELETE FROM public.organizations WHERE id = ANY(p_organization_ids);
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    -- Restaurar rol por defecto
    SET LOCAL session_replication_role = DEFAULT;

    RETURN jsonb_build_object(
        'deletedCount', v_deleted_count,
        'deletedIds', v_deleted_ids
    );
END;
$$;

COMMENT ON FUNCTION public.admin_delete_organizations_cascade IS
    'Elimina en cascada organizaciones y sus datos asociados desactivando temporalmente triggers append-only (usage_events, contact_notes, feature_audit_log) dentro de una transacción admin.';
