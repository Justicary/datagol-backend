-- =============================================================================
-- Datagol — Migración 57: aprovisionamiento automático de grupo de
-- credenciales + webhook_token de grupo
-- =============================================================================
-- Cierra dos huecos descubiertos al implementar
-- docs/tasks/catalogo-productos-grupos-cred.md sobre la migración 56 ya
-- aplicada:
--
--   1. `organizations.credential_group_id` es NOT NULL desde la migración 56,
--      pero ningún trigger ni función crea el grupo de uno automáticamente al
--      insertar una organización nueva. `create_organization_with_owner()`
--      (migración 08) sigue haciendo un INSERT liso — sin esto, toda alta
--      nueva de organización falla. Se corrige con DOS triggers (BEFORE +
--      AFTER, ver comentario en BLOQUE 1 — el porqué de dos no es obvio: es
--      para no violar la FK de credential_groups.owner_organization_id, que
--      referencia una fila de organizations que en el momento del BEFORE
--      INSERT todavía no existe físicamente).
--
--   CORRECCIÓN 2026-08-23: la primera versión de este bloque usaba un solo
--   trigger BEFORE INSERT que insertaba credential_groups con
--   owner_organization_id = new.id directamente — viola la FK descrita
--   arriba y rompía TODA alta de organización con
--   "credential_groups_owner_fk" en cuanto se aplicó contra la base viva.
--   Verificado y corregido en la misma sesión, antes de que nadie dependiera
--   de la versión rota en producción. Si esta migración ya se aplicó con la
--   versión anterior, volver a correr este archivo completo es seguro y
--   necesario: `create or replace function` reemplaza las funciones,
--   `drop trigger if exists` + `create trigger` reemplaza los triggers, y el
--   resto del archivo (BLOQUE 2/3) es idempotente.
--
--   2. FASE B.3 del task doc: el webhook de post-llamada de ElevenLabs debe
--      resolver primero el GRUPO de credenciales (no la organización) cuando
--      el workspace es compartido, para poder verificar la firma con el
--      secreto único del grupo antes de leer `agent_id` del cuerpo.
--      `credential_groups` no tenía columna de enrutamiento propia — se
--      agrega aquí, retro-llenada desde el `webhook_token` que ya tenía cada
--      organización dueña. No se toca `organizations.webhook_token`: sigue
--      siendo el que usan las tools (`routes/tools/**`), un espacio de
--      nombres distinto del webhook de post-llamada.
--
-- Requiere aplicación manual contra la base viva, igual que toda migración de
-- este repo (no hay script de migrate/psql automatizado).
-- =============================================================================


-- =============================================================================
-- BLOQUE 1 — Aprovisionamiento automático de credential_groups
-- =============================================================================

-- Dos triggers, no uno, por una razón de integridad referencial nada obvia:
-- credential_groups.owner_organization_id referencia organizations(id). En
-- un trigger BEFORE INSERT sobre organizations, new.id ya está resuelto
-- (el default gen_random_uuid() se aplica antes), pero la FILA AÚN NO EXISTE
-- en la tabla — insertar credential_groups con owner_organization_id = new.id
-- en ese punto viola la FK (el organizations.id referenciado no existe
-- todavía). Se resuelve en dos pasos: el BEFORE crea el grupo SIN owner
-- (columna nullable, no viola nada) y enlaza la organización a él; el AFTER
-- —cuando la fila de organizations ya existe de verdad— completa el owner.
create or replace function provision_credential_group_for_new_org()
returns trigger language plpgsql
security definer set search_path = public, pg_temp
as $$
declare v_group uuid;
begin
  if new.credential_group_id is not null then
    return new;
  end if;

  insert into credential_groups (name, owner_organization_id)
  values (new.name, null)
  returning id into v_group;

  new.credential_group_id := v_group;
  return new;
end;
$$;

create or replace function backfill_credential_group_owner()
returns trigger language plpgsql
security definer set search_path = public, pg_temp
as $$
begin
  update credential_groups
  set owner_organization_id = new.id
  where id = new.credential_group_id
    and owner_organization_id is null;

  return new;
end;
$$;

drop trigger if exists trg_provision_credential_group on organizations;
create trigger trg_provision_credential_group
  before insert on organizations
  for each row execute function provision_credential_group_for_new_org();

drop trigger if exists trg_backfill_credential_group_owner on organizations;
create trigger trg_backfill_credential_group_owner
  after insert on organizations
  for each row execute function backfill_credential_group_owner();

comment on function provision_credential_group_for_new_org() is
  'Crea un credential_groups de uno (sin owner todavía — ver backfill_credential_group_owner) cuando el INSERT no trae credential_group_id explícito. Cierra el hueco dejado por la migración 56, que solo retro-llenó organizaciones existentes.';

comment on function backfill_credential_group_owner() is
  'Completa owner_organization_id del grupo recién creado por provision_credential_group_for_new_org(), una vez que la fila de organizations ya existe de verdad (AFTER INSERT) y no viola la FK de credential_groups.owner_organization_id. El WHERE owner_organization_id is null hace que nunca pise un grupo que ya tenía owner explícito (p. ej. una organización insertada ya con credential_group_id de un grupo compartido existente).';


-- =============================================================================
-- BLOQUE 2 — webhook_token de grupo (FASE B.3)
-- =============================================================================

alter table credential_groups
  add column if not exists webhook_token text;

create unique index if not exists ux_credential_groups_webhook_token
  on credential_groups (webhook_token)
  where webhook_token is not null;

comment on column credential_groups.webhook_token is
  'Identificador de enrutamiento (no criptográfico, igual que organizations.webhook_token) del webhook de post-llamada de ElevenLabs cuando el workspace es compartido: POST /webhooks/elevenlabs/:webhookToken resuelve el GRUPO por esta columna, verifica la firma con el secreto único del grupo, y solo entonces lee agent_id del cuerpo para resolver la organización. Distinto de organizations.webhook_token (tools, routes/tools/**), que no cambia.';

-- Retro-llenado: cada grupo hereda el webhook_token de su organización dueña.
-- En grupo de uno, es el mismo valor que ya usaba esa organización para el
-- webhook de post-llamada — el camino queda idéntico al de antes.
update credential_groups g
set webhook_token = o.webhook_token
from organizations o
where o.id = g.owner_organization_id
  and g.webhook_token is null
  and o.webhook_token is not null;


-- =============================================================================
-- BLOQUE 3 — Aviso de cuota blanda de concurrencia (FASE B.4)
-- =============================================================================
-- No reutiliza organization_usage_alerts (migración 31): esa tabla tiene un
-- CHECK constraint cerrado a los 3 umbrales de créditos de ElevenLabs y su
-- dedup es por CICLO DE FACTURACIÓN (cycle_reset_at), un concepto que no
-- aplica aquí — la concurrencia se mide en vivo, no por ciclo. Dedup: como
-- mucho un aviso por organización por día (alert_date), para no inundar al
-- administrador en cada corrida del sweep mientras la sucursal siga saturada.

create table if not exists concurrency_quota_alerts (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,
  credential_group_id uuid not null references credential_groups(id) on delete cascade,
  current_count     int not null,
  soft_limit        int not null,
  alert_date        date not null default current_date,
  sent_at           timestamptz not null default now(),
  unique (organization_id, alert_date)
);

create index if not exists idx_concurrency_quota_alerts_org
  on concurrency_quota_alerts (organization_id, alert_date desc);

alter table concurrency_quota_alerts enable row level security;

comment on table concurrency_quota_alerts is
  'Aviso (no bloqueo) de que una organización rebasó su organization_concurrency_quota.soft_limit dentro del pozo compartido del grupo. RLS habilitada sin políticas: solo service_role la escribe/lee, mismo patrón que organization_usage_alerts (migración 31).';


-- =============================================================================
-- BLOQUE 4 — Verificación
-- =============================================================================

-- Ninguna organización nueva debe poder quedar sin grupo:
-- insert into organizations (name, email) values ('Prueba trigger', 'x@x.invalid') returning credential_group_id;

-- Grupos con webhook_token retro-llenado:
-- select id, name, webhook_token from credential_groups where owner_organization_id is not null;

-- Ningún webhook_token de grupo debe repetirse:
-- select webhook_token, count(*) from credential_groups where webhook_token is not null group by 1 having count(*) > 1;
