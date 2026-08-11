-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- "Restaurar valores de fábrica" (consola /admin): vacía por completo
-- `appointments`, `call_logs`, `contacts`, `feature_audit_log` y `leads`
-- para que la instalación de un solo tenant (AGENTS.md, modelo DFY) pueda
-- reiniciarse limpia para un cliente nuevo, sin arrastrar el historial de
-- interacciones del cliente anterior. `organizations`, `plans`, `features`,
-- `organization_secrets`, `usage_events` y `webhook_events` NUNCA se tocan
-- aquí — son catálogo/infraestructura/facturación, no historial de
-- interacciones, y el usuario no los pidió.
--
-- DELETE, no TRUNCATE, a propósito: las 5 tablas tienen FKs entrantes desde
-- `usage_events` (call_logs.id) además de entre sí, todas ON DELETE SET
-- NULL. `TRUNCATE` sin CASCADE falla con esas FKs entrantes, y con CASCADE
-- se llevaría también `usage_events` (historial de facturación, fuera del
-- alcance pedido). `DELETE` respeta el SET NULL fila por fila: al borrar
-- `call_logs`, `usage_events.call_log_id` queda en NULL en vez de que la
-- fila se pierda — el consumo ya facturado se conserva íntegro.
--
-- Verificado contra la base real (transacción de prueba con ROLLBACK, no
-- contra el CI): `usage_events` es append-only (trigger
-- `trg_usage_no_update`/`forbid_usage_mutation`, ver migración de Fase 3) y
-- bloquea CUALQUIER UPDATE, incluido el SET NULL implícito que dispara la
-- FK al borrar `call_logs`. Sin esto, `DELETE FROM call_logs` fallaba con
-- "usage_events es append-only. Registre un asiento compensatorio."
-- `SET LOCAL session_replication_role = replica` desactiva los triggers
-- (incluida la propia aplicación de FKs) solo dentro de esta transacción —
-- revierte solo a 'origin' al terminar (COMMIT o ROLLBACK), nunca se filtra
-- a otras sesiones. El UPDATE explícito a NULL antes de borrar `call_logs`
-- dentro de esa ventana logra el mismo resultado que el SET NULL de la FK
-- habría hecho — el importe ya facturado (`amount_usd`, `quantity`, etc.)
-- de `usage_events` no se toca, solo la referencia de vuelta a la llamada.
--
-- Orden de borrado: primero las tablas "hoja" (appointments, leads) que
-- referencian a call_logs/contacts, después call_logs, después contacts,
-- para que ningún DELETE dependa de un ON DELETE SET NULL de una fila que
-- todavía no se ha borrado (aunque con SET NULL el orden no es
-- estrictamente obligatorio, mantenerlo documenta la intención y evita
-- sorpresas si algún día una FK cambia de SET NULL a RESTRICT).
--
-- SECURITY DEFINER: mismo patrón que `erase_contact_pii` — se invoca desde
-- datagol-backend (supabaseAdmin) tras verificar `isPlatformAdmin`, nunca
-- expuesta a un cliente sin auditar primero en la capa de la ruta.
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

    -- Limpia la referencia colgante ANTES de borrar call_logs. Sin
    -- session_replication_role=replica de arriba, este UPDATE por sí solo
    -- ya sería rechazado por el trigger append-only de usage_events.
    UPDATE public.usage_events SET call_log_id = NULL WHERE call_log_id IS NOT NULL;

    DELETE FROM public.appointments;
    GET DIAGNOSTICS v_appointments_deleted = ROW_COUNT;

    DELETE FROM public.leads;
    GET DIAGNOSTICS v_leads_deleted = ROW_COUNT;

    DELETE FROM public.call_logs;
    GET DIAGNOSTICS v_call_logs_deleted = ROW_COUNT;

    DELETE FROM public.contacts;
    GET DIAGNOSTICS v_contacts_deleted = ROW_COUNT;

    DELETE FROM public.feature_audit_log;
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
    'Vacía appointments/call_logs/contacts/feature_audit_log/leads por completo (sin WHERE — no es por organización). DELETE en vez de TRUNCATE para no arrastrar CASCADE hacia usage_events (facturación, fuera de alcance). Invocada solo desde POST /api/admin/factory-reset (isPlatformAdmin + frase de confirmación exacta). Acción irreversible: no hay respaldo automático.';
