-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 81_permission_audit_log_user_delete.sql
-- =============================================================================
-- Borrado de usuarios bloqueado por `permission_audit_log`.
--
-- `target_user_id` y `actor_user_id` referencian `auth.users` sin acción
-- (45_rbac_permisos.sql). Un usuario que alguna vez invitó, cambió un rol o
-- fue invitado/removido no se puede borrar de Auth: HTTP 500 en
-- auth.admin.deleteUser. Así se acumulaban como basura los usuarios
-- `test-members-*` de __tests__/organization-members.test.ts, y lo mismo le
-- pasaría a un usuario real que pida su baja.
--
-- Corrección, mismo patrón que la 47 (organization_id), la 79
-- (quotation_events) y la 80 (deployment_events): las dos FKs pasan a ON
-- DELETE SET NULL y el trigger append-only permite exactamente esos UPDATE —
-- columnas de referencia que pasan de un valor a NULL — y nada más. La fila
-- de bitácora sobrevive; solo pierde la referencia al usuario borrado.
-- =============================================================================

create or replace function forbid_perm_audit_mutation()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     -- Cada columna de referencia queda igual o pasa a NULL (ON DELETE SET NULL
     -- de organizations o auth.users)...
     and (NEW.organization_id is not distinct from OLD.organization_id or NEW.organization_id is null)
     and (NEW.target_user_id  is not distinct from OLD.target_user_id  or NEW.target_user_id  is null)
     and (NEW.actor_user_id   is not distinct from OLD.actor_user_id   or NEW.actor_user_id   is null)
     -- ...y todo lo demás es idéntico.
     and NEW.id = OLD.id
     and OLD.role           is not distinct from NEW.role
     and OLD.permission_key is not distinct from NEW.permission_key
     and OLD.action          = NEW.action
     and OLD.previous_value is not distinct from NEW.previous_value
     and OLD.new_value      is not distinct from NEW.new_value
     and OLD.reason         is not distinct from NEW.reason
     and OLD.created_at      = NEW.created_at
  then
    return NEW;
  end if;

  raise exception 'permission_audit_log es append-only.';
end;
$$;

comment on function forbid_perm_audit_mutation() is
  'Bloquea UPDATE/DELETE en permission_audit_log salvo los SET NULL que disparan organizations y auth.users ON DELETE (migraciones 47 y 81).';

-- Las FKs se declararon en línea en la 45: se buscan por definición, no por nombre.
do $$
declare
  v_conname text;
begin
  for v_conname in
    select c.conname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.contype = 'f'
       and c.conrelid = 'public.permission_audit_log'::regclass
       and c.confrelid = 'auth.users'::regclass
       and a.attname in ('target_user_id', 'actor_user_id')
  loop
    execute format('alter table public.permission_audit_log drop constraint %I', v_conname);
  end loop;
end $$;

alter table public.permission_audit_log
  add constraint permission_audit_log_target_user_id_fkey
  foreign key (target_user_id) references auth.users(id) on delete set null;

alter table public.permission_audit_log
  add constraint permission_audit_log_actor_user_id_fkey
  foreign key (actor_user_id) references auth.users(id) on delete set null;
