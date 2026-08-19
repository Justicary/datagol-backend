-- =============================================================================
-- Datagol — Migración: corrige forbid_perm_audit_mutation vs.
-- organizations→permission_audit_log ON DELETE SET NULL
-- =============================================================================
-- Bug descubierto durante la implementación de docs/tasks/RBAC-permisos.md
-- (FASE E, auditoría de datos): `permission_audit_log.organization_id`
-- referencia `organizations(id) on delete set null` (migración 45, BLOQUE 3)
-- — la intención es que la bitácora sobreviva al borrado de la
-- organización, solo perdiendo la referencia. Pero el mismo BLOQUE 3
-- también agrega `forbid_perm_audit_mutation`, un trigger BEFORE UPDATE OR
-- DELETE que rechaza CUALQUIER mutación sin excepción — incluida la
-- actualización que la propia base genera internamente para aplicar el
-- "SET NULL" del ON DELETE. Resultado real (verificado contra la base):
-- borrar una organización que tiene aunque sea una fila en
-- permission_audit_log falla con "permission_audit_log es append-only",
-- código P0001 — no una excepción de la aplicación, un bloqueo real de la
-- base para SIEMPRE borrar esa organización por REST (`DELETE FROM
-- organizations`), sin importar quién lo pida.
--
-- Esto no es hipotético: 9 organizaciones de prueba de esta misma tarea
-- quedaron huérfanas (sin poder borrarse) en cuanto alguna de las
-- operaciones de RBAC (invitar, cambiar rol, override) les escribió una
-- fila de auditoría. `admin_delete_organizations_cascade` (migración 29)
-- podría estar protegido por su `SET LOCAL session_replication_role =
-- replica`, pero cualquier borrado que NO pase por esa función específica
-- (incluida una llamada REST directa, o una futura ruta que borre
-- organizaciones) queda atrapado sin aviso previo en el código de la
-- aplicación.
--
-- Corrección: el trigger sigue bloqueando TODO UPDATE/DELETE salvo el caso
-- exacto de "la base está aplicando el ON DELETE SET NULL de
-- organization_id y ninguna otra columna cambia" — ese es el único UPDATE
-- que el propio esquema define como legítimo sobre esta tabla append-only.
-- =============================================================================

create or replace function forbid_perm_audit_mutation()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and OLD.organization_id is not null
     and NEW.organization_id is null
     and OLD.role                is not distinct from NEW.role
     and OLD.permission_key      is not distinct from NEW.permission_key
     and OLD.action               = NEW.action
     and OLD.previous_value      is not distinct from NEW.previous_value
     and OLD.new_value           is not distinct from NEW.new_value
     and OLD.target_user_id      is not distinct from NEW.target_user_id
     and OLD.reason              is not distinct from NEW.reason
     and OLD.actor_user_id       is not distinct from NEW.actor_user_id
     and OLD.created_at           = NEW.created_at
  then
    -- Único caso permitido: el ON DELETE SET NULL de
    -- organizations→permission_audit_log.organization_id (migración 45).
    return NEW;
  end if;

  raise exception 'permission_audit_log es append-only.';
end;
$$;

comment on function forbid_perm_audit_mutation() is
  'Bloquea UPDATE/DELETE en permission_audit_log salvo el SET NULL de organization_id que dispara organizations ON DELETE (para que borrar una organización no quede permanentemente bloqueado). Ver docs/tasks/RBAC-permisos.md FASE E.';
