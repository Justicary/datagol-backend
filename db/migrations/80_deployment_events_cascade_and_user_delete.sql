-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 80_deployment_events_cascade_and_user_delete.sql
-- =============================================================================
-- Dos correcciones a la bitácora append-only `deployment_events`
-- (55_control_plane_datagol.sql), mismo patrón que quotation_events en la
-- migración 79 y permission_audit_log en la 47.
--
-- 1) Borrado de un despliegue. `deployment_events.deployment_id` referencia
-- `deployments ON DELETE CASCADE`, pero el trigger rechazaba todo DELETE —
-- incluido el que la propia base genera para aplicar esa cascada. Resultado:
-- ningún despliegue con eventos (todos: crear uno ya registra `creado`) podía
-- borrarse, y las pruebas de /control/** dejaban sus `demo-test-*` como
-- basura. Ahora se permite el DELETE solo cuando el despliegue padre ya no
-- existe, es decir, únicamente como cascada. Un DELETE directo sigue
-- rechazado. Un despliegue real no queda expuesto: `contracts` y `licenses`
-- lo referencian con ON DELETE RESTRICT.
--
-- 2) Borrado de usuarios. `actor_user_id` referenciaba `auth.users` sin acción,
-- así que un usuario que alguna vez actuó sobre un despliegue no se podía
-- borrar de Auth (HTTP 500 en auth.admin.deleteUser). Pasa a ON DELETE SET
-- NULL, y el trigger permite exactamente ese UPDATE y nada más.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.forbid_deployment_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Único UPDATE legítimo: el ON DELETE SET NULL de
        -- auth.users → deployment_events.actor_user_id.
        IF OLD.actor_user_id IS NOT NULL
           AND NEW.actor_user_id IS NULL
           AND NEW.id = OLD.id
           AND NEW.deployment_id = OLD.deployment_id
           AND NEW.event_type = OLD.event_type
           AND NEW.description IS NOT DISTINCT FROM OLD.description
           AND NEW.previous_value IS NOT DISTINCT FROM OLD.previous_value
           AND NEW.new_value IS NOT DISTINCT FROM OLD.new_value
           AND NEW.metadata = OLD.metadata
           AND NEW.created_at = OLD.created_at THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'deployment_events es append-only.';
    END IF;

    -- DELETE: solo como cascada del borrado del despliegue padre (la acción
    -- referencial corre después de borrar al padre, que ya no es visible).
    IF NOT EXISTS (SELECT 1 FROM public.deployments d WHERE d.id = OLD.deployment_id) THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'deployment_events es append-only.';
END;
$$;

-- La FK se declaró en línea en la 55: se busca por definición, no por nombre.
DO $$
DECLARE
    v_conname text;
BEGIN
    FOR v_conname IN
        SELECT c.conname
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
         WHERE c.contype = 'f'
           AND c.conrelid = 'public.deployment_events'::regclass
           AND c.confrelid = 'auth.users'::regclass
           AND a.attname = 'actor_user_id'
    LOOP
        EXECUTE format('ALTER TABLE public.deployment_events DROP CONSTRAINT %I', v_conname);
    END LOOP;
END $$;

ALTER TABLE public.deployment_events
    ADD CONSTRAINT deployment_events_actor_user_id_fkey
    FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
