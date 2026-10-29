-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 78_admin_delete_organizations_full_cascade.sql
-- =============================================================================
-- Corrige `admin_delete_organizations_cascade` (migración 29), que usa el panel
-- de superadmin (`mi-new-app/src/app/api/admin/organizations/delete`).
--
-- Bug: la función hacía TODO el borrado con `session_replication_role =
-- replica`. Ese modo no solo apaga los triggers append-only: también apaga la
-- aplicación de llaves foráneas, así que ningún `ON DELETE CASCADE` se
-- ejecutaba. Solo se borraban las tablas listadas a mano en 2026-08; todo lo
-- agregado después quedaba huérfano al borrar una organización:
-- `catalogs` (y sus productos, variantes, accesos, importaciones),
-- `quotations` y sus partidas/entregas/eventos (migración 77), buzones,
-- Telegram, etc. Verificado contra la base: 34 catálogos con
-- `owner_organization_id` inexistente.
--
-- Corrección: `replica` se usa SOLO para borrar las filas de las tablas
-- append-only cuyo trigger rechaza el DELETE (usage_events, contact_notes,
-- feature_audit_log). Después se restaura el rol y se borra la organización
-- con un DELETE normal: las FKs con cascada eliminan todo lo demás, incluido
-- lo que se agregue en migraciones futuras. Si alguna FK no tiene cascada, el
-- borrado falla completo (transacción revertida) en vez de dejar huérfanos.
--
-- permission_audit_log no se toca: su FK es ON DELETE SET NULL y el trigger
-- permite ese caso (migración 47); la bitácora sobrevive sin la referencia.
-- quotation_events / quotation_items permiten el DELETE en cascada cuando la
-- cotización padre ya no existe (migración 77).
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
    SELECT array_agg(id) INTO v_deleted_ids
    FROM public.organizations
    WHERE id = ANY(p_organization_ids);

    IF v_deleted_ids IS NULL THEN
        v_deleted_ids := ARRAY[]::uuid[];
    END IF;

    -- 1. Solo las tablas append-only cuyo trigger rechaza el DELETE.
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.usage_events      WHERE organization_id = ANY(p_organization_ids);
    DELETE FROM public.contact_notes     WHERE organization_id = ANY(p_organization_ids);
    DELETE FROM public.feature_audit_log WHERE organization_id = ANY(p_organization_ids);
    SET LOCAL session_replication_role = DEFAULT;

    -- 2. Borrado normal: las FKs con cascada eliminan el resto sin huérfanos.
    DELETE FROM public.organizations WHERE id = ANY(p_organization_ids);
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'deletedCount', v_deleted_count,
        'deletedIds', v_deleted_ids
    );
END;
$$;

COMMENT ON FUNCTION public.admin_delete_organizations_cascade IS
    'Elimina organizaciones: borra con session_replication_role=replica solo las filas append-only (usage_events, contact_notes, feature_audit_log) y luego hace un DELETE normal para que las FKs con cascada eliminen todo lo demás sin huérfanos (migración 78).';

REVOKE ALL ON FUNCTION public.admin_delete_organizations_cascade(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_organizations_cascade(uuid[]) TO service_role;
