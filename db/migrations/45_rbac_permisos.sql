-- =============================================================================
-- Datagol — Migración: RBAC aplicado, permisos configurables y asientos
-- =============================================================================
-- Dos cosas distintas en una migración:
--
--   1. CORRECCIÓN DE SEGURIDAD (todos los planes). organization_members.role
--      existe desde el inicio pero ninguna política RLS lo consulta. Hoy
--      cualquier miembro, incluido un 'viewer', puede modificar la fila de su
--      organización: plan_key, retention_days, webhook_token.
--
--   2. FEATURE rbac_access (todos los planes, con asientos por plan). Roles
--      con permisos reales, invitaciones, y un mapa de permisos que el
--      superadmin puede ajustar por organización.
--
-- Orden de resolución de un permiso:
--   invariante de owner → override de la organización → default del rol → negar
-- =============================================================================


-- =============================================================================
-- BLOQUE 0 — Auditoría previa (ejecutar y leer antes de continuar)
-- =============================================================================

-- ¿Cuántos usuarios tiene cada organización y con qué roles?
select o.name, m.role, count(*)
from organization_members m
join organizations o on o.id = m.organization_id
group by 1, 2
order by 1, 2;

-- ¿Alguna organización se quedaría sin owner?
select o.id, o.name
from organizations o
where not exists (
  select 1 from organization_members m
  where m.organization_id = o.id and m.role = 'owner'
);

-- Si la segunda consulta devuelve filas, asigna un owner ANTES de continuar.
-- Una organización sin owner queda sin nadie que pueda administrarla.


-- =============================================================================
-- BLOQUE 1 — Catálogo de permisos
-- =============================================================================

create table if not exists permissions (
  key           text primary key,
  name          text not null,
  description   text,
  category      text not null
                check (category in ('datos','operacion','finanzas','configuracion','usuarios')),
  -- Sensible: otorgarlo a un rol bajo abre una vía de escalamiento. La
  -- interfaz debe exigir confirmación explícita al moverlo.
  is_sensitive  boolean not null default false,
  sort_order    int not null default 100,
  created_at    timestamptz not null default now()
);

insert into permissions (key, name, description, category, is_sensitive, sort_order) values
  ('view_contacts',      'Ver contactos y pipeline',    'Consultar el CRM y el embudo',                      'datos',         false, 10),
  ('view_conversations', 'Ver conversaciones',          'Resúmenes de llamadas y mensajes',                  'datos',         false, 20),
  ('view_transcripts',   'Ver transcripciones',         'Texto completo. Contiene datos personales de terceros', 'datos',     true,  30),
  ('edit_contacts',      'Editar contactos',            'Modificar datos, notas y direcciones',              'operacion',     false, 40),
  ('manage_pipeline',    'Mover pipeline y citas',      'Cambiar etapa y marcar desenlace de citas',          'operacion',     false, 50),
  ('close_deals',        'Cerrar ventas',               'Marcar ganado y capturar el monto',                 'operacion',     false, 60),
  ('view_costs',         'Ver costos y consumo',        'Cuánto gasta la organización en infraestructura',   'finanzas',      true,  70),
  ('view_revenue',       'Ver resultado de negocio',    'Ventas, ticket promedio, resultado del mes',        'finanzas',      true,  80),
  ('use_nl_reports',     'Usar reportes con IA',        'Consume la llave de IA de la organización',         'finanzas',      true,  90),
  ('configure_agent',    'Configurar el agente',        'Prompt, voz y base de conocimiento',                'configuracion', true,  100),
  ('export_data',        'Exportar datos',              'Descargar contactos y conversaciones',              'datos',         true,  110),
  ('manage_users',       'Gestionar usuarios',          'Invitar, cambiar rol y desactivar',                 'usuarios',      true,  120),
  ('manage_credentials', 'Gestionar credenciales',      'Llaves de ElevenLabs, Telnyx, Meta, IA',            'configuracion', true,  130),
  ('change_plan',        'Cambiar de plan',             'Contratar o modificar el plan',                     'configuracion', true,  140),
  ('erase_contact_data', 'Borrado ARCO',                'Eliminar datos personales de un contacto',          'configuracion', true,  150)
on conflict (key) do nothing;


-- =============================================================================
-- BLOQUE 2 — Mapa por defecto de rol a permiso
-- =============================================================================

create table if not exists role_permissions (
  role           text not null check (role in ('owner','admin','member','viewer')),
  permission_key text not null references permissions(key) on delete cascade,
  enabled        boolean not null default true,
  primary key (role, permission_key)
);

-- viewer: solo lectura, sin PII de terceros ni información financiera.
insert into role_permissions (role, permission_key) values
  ('viewer','view_contacts'), ('viewer','view_conversations')
on conflict do nothing;

-- member: opera el día a día.
insert into role_permissions (role, permission_key) values
  ('member','view_contacts'), ('member','view_conversations'),
  ('member','view_transcripts'), ('member','edit_contacts'),
  ('member','manage_pipeline')
on conflict do nothing;

-- admin: todo salvo credenciales, plan y borrado ARCO.
insert into role_permissions (role, permission_key) values
  ('admin','view_contacts'), ('admin','view_conversations'),
  ('admin','view_transcripts'), ('admin','edit_contacts'),
  ('admin','manage_pipeline'), ('admin','close_deals'),
  ('admin','view_costs'), ('admin','view_revenue'),
  ('admin','use_nl_reports'), ('admin','configure_agent'),
  ('admin','export_data'), ('admin','manage_users')
on conflict do nothing;

-- owner: todo.
insert into role_permissions (role, permission_key)
select 'owner', key from permissions
on conflict do nothing;


-- =============================================================================
-- BLOQUE 3 — Overrides del superadmin
-- =============================================================================
-- Mismo patrón que organization_features: razón obligatoria y vigencia
-- opcional. En seis meses nadie recuerda por qué una organización tiene un
-- permiso movido.

create table if not exists organization_role_permissions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  role            text not null check (role in ('owner','admin','member','viewer')),
  permission_key  text not null references permissions(key) on delete cascade,
  enabled         boolean not null,
  reason          text not null,
  expires_at      timestamptz,
  granted_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, role, permission_key)
);

create index if not exists idx_org_role_perms
  on organization_role_permissions (organization_id, role);
create index if not exists idx_org_role_perms_expiring
  on organization_role_permissions (expires_at) where expires_at is not null;

drop trigger if exists trg_org_role_perms_updated on organization_role_permissions;
create trigger trg_org_role_perms_updated before update on organization_role_permissions
  for each row execute function set_updated_at();

create table if not exists permission_audit_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete set null,
  role            text,
  permission_key  text,
  action          text not null check (action in ('granted','revoked','expired','role_changed','user_invited','user_removed')),
  previous_value  boolean,
  new_value       boolean,
  target_user_id  uuid references auth.users(id),
  reason          text,
  actor_user_id   uuid references auth.users(id),
  created_at      timestamptz not null default now()
);

create index if not exists idx_perm_audit_org
  on permission_audit_log (organization_id, created_at desc);

create or replace function forbid_perm_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'permission_audit_log es append-only.';
end;
$$;

drop trigger if exists trg_perm_audit_no_update on permission_audit_log;
create trigger trg_perm_audit_no_update
  before update or delete on permission_audit_log
  for each row execute function forbid_perm_audit_mutation();


-- =============================================================================
-- BLOQUE 4 — Resolución
-- =============================================================================

create or replace function auth_role_in_org(p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from organization_members
  where organization_id = p_org_id and user_id = auth.uid()
  limit 1;
$$;

create or replace function has_permission(p_org_id uuid, p_permission text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role     text;
  v_override boolean;
  v_default  boolean;
begin
  v_role := auth_role_in_org(p_org_id);
  if v_role is null then
    return false;                       -- no es miembro
  end if;

  -- INVARIANTE: el owner nunca pierde la gestión de usuarios. Sin esto, un
  -- override puede dejar a una organización sin nadie que la administre.
  if v_role = 'owner' and p_permission in ('manage_users','change_plan') then
    return true;
  end if;

  select enabled into v_override
  from organization_role_permissions
  where organization_id = p_org_id
    and role = v_role
    and permission_key = p_permission
    and (expires_at is null or expires_at > now());

  if v_override is not null then
    return v_override;
  end if;

  select enabled into v_default
  from role_permissions
  where role = v_role and permission_key = p_permission;

  return coalesce(v_default, false);    -- negar por defecto
end;
$$;

-- Conjunto completo de permisos del usuario en una organización.
-- Una sola llamada; el backend nunca consulta permiso por permiso.
create or replace function auth_permissions_in_org(p_org_id uuid)
returns table (permission_key text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.key from permissions p
  where has_permission(p_org_id, p.key);
$$;

-- Expiración automática de overrides temporales.
create or replace function expire_role_permission_overrides()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into permission_audit_log (organization_id, role, permission_key, action, previous_value, reason)
  select organization_id, role, permission_key, 'expired', enabled, 'Vigencia terminada: ' || coalesce(reason,'')
  from organization_role_permissions
  where expires_at is not null and expires_at <= now();

  delete from organization_role_permissions
  where expires_at is not null and expires_at <= now();
end;
$$;

select cron.schedule(
  'expire-role-permission-overrides',
  '45 3 * * *',
  $$ select expire_role_permission_overrides(); $$
);


-- =============================================================================
-- BLOQUE 5 — Asientos por plan
-- =============================================================================

alter table plans add column if not exists max_users int not null default 2;

update plans set max_users = case key
  when 'starter'    then 2
  when 'pro'        then 5
  when 'elite'      then 15
  when 'enterprise' then 999
  else 2
end;

comment on column plans.max_users is
  'Asientos incluidos. Las invitaciones pendientes cuentan contra el límite.';


-- =============================================================================
-- BLOQUE 6 — Invitaciones
-- =============================================================================

create table if not exists organization_invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email           text not null,
  role            text not null check (role in ('admin','member','viewer')),
  token_hash      text not null unique,
  invited_by      uuid references auth.users(id),
  expires_at      timestamptz not null default now() + interval '7 days',
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

-- No se puede invitar como owner: la transferencia es un flujo aparte.
create unique index if not exists ux_invitations_pending
  on organization_invitations (organization_id, lower(email))
  where accepted_at is null and revoked_at is null;

create index if not exists idx_invitations_org
  on organization_invitations (organization_id, created_at desc);

-- Ocupación de asientos: miembros activos + invitaciones vigentes.
create or replace function organization_seats_used(p_org_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    (select count(*) from organization_members where organization_id = p_org_id)
  + (select count(*) from organization_invitations
     where organization_id = p_org_id
       and accepted_at is null and revoked_at is null and expires_at > now());
$$;

create or replace function enforce_seat_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org   uuid;
  v_limit int;
begin
  v_org := new.organization_id;

  select p.max_users into v_limit
  from organizations o join plans p on p.key = o.plan_key
  where o.id = v_org;

  if v_limit is null then
    v_limit := 2;
  end if;

  if organization_seats_used(v_org) >= v_limit then
    raise exception 'Límite de % usuarios alcanzado para el plan contratado.', v_limit
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_seat_limit_members on organization_members;
create trigger trg_seat_limit_members
  before insert on organization_members
  for each row execute function enforce_seat_limit();

drop trigger if exists trg_seat_limit_invitations on organization_invitations;
create trigger trg_seat_limit_invitations
  before insert on organization_invitations
  for each row execute function enforce_seat_limit();


-- =============================================================================
-- BLOQUE 7 — Corrección del hueco de seguridad
-- =============================================================================
-- org_self_access era FOR ALL: cualquier miembro podía modificar plan_key,
-- retention_days, webhook_token y demás configuración de su organización.

drop policy if exists org_self_access on organizations;

create policy org_read on organizations
  for select to authenticated
  using (id in (select auth_active_organization_ids()) or is_platform_admin());

create policy org_update on organizations
  for update to authenticated
  using (has_permission(id, 'configure_agent') or is_platform_admin())
  with check (has_permission(id, 'configure_agent') or is_platform_admin());

-- Sin política de INSERT ni DELETE para authenticated: alta y baja de
-- organizaciones pasan por el backend con service_role.

-- Escritura de datos operativos sujeta a permiso.
drop policy if exists tenant_isolation on contacts;
create policy contacts_read on contacts
  for select to authenticated
  using (has_permission(organization_id, 'view_contacts'));
create policy contacts_write on contacts
  for all to authenticated
  using (has_permission(organization_id, 'edit_contacts'))
  with check (has_permission(organization_id, 'edit_contacts'));

drop policy if exists tenant_isolation on leads;
create policy leads_read on leads
  for select to authenticated
  using (has_permission(organization_id, 'view_contacts'));
create policy leads_write on leads
  for all to authenticated
  using (has_permission(organization_id, 'manage_pipeline'))
  with check (has_permission(organization_id, 'manage_pipeline'));

drop policy if exists tenant_isolation on appointments;
create policy appointments_read on appointments
  for select to authenticated
  using (has_permission(organization_id, 'view_contacts'));
create policy appointments_write on appointments
  for all to authenticated
  using (has_permission(organization_id, 'manage_pipeline'))
  with check (has_permission(organization_id, 'manage_pipeline'));

-- Costos: solo quien tenga el permiso.
drop policy if exists tenant_read_usage on usage_events;
create policy usage_read on usage_events
  for select to authenticated
  using (has_permission(organization_id, 'view_costs'));

-- Notas y direcciones siguen la escritura de contactos.
drop policy if exists tenant_isolation on contact_notes;
create policy notes_read on contact_notes
  for select to authenticated
  using (has_permission(organization_id, 'view_contacts'));
create policy notes_write on contact_notes
  for insert to authenticated
  with check (has_permission(organization_id, 'edit_contacts'));

drop policy if exists tenant_isolation on contact_addresses;
create policy addresses_read on contact_addresses
  for select to authenticated
  using (has_permission(organization_id, 'view_contacts'));
create policy addresses_write on contact_addresses
  for all to authenticated
  using (has_permission(organization_id, 'edit_contacts'))
  with check (has_permission(organization_id, 'edit_contacts'));

-- call_logs: la restricción de transcripciones es POR COLUMNA y RLS no la
-- resuelve. Se aplica en la capa de API (ver brief). Aquí solo el acceso
-- a nivel de fila.
drop policy if exists tenant_isolation on call_logs;
create policy call_logs_read on call_logs
  for select to authenticated
  using (has_permission(organization_id, 'view_conversations'));


-- =============================================================================
-- BLOQUE 8 — RLS de las tablas nuevas
-- =============================================================================

alter table permissions                    enable row level security;
alter table role_permissions               enable row level security;
alter table organization_role_permissions  enable row level security;
alter table permission_audit_log           enable row level security;
alter table organization_invitations       enable row level security;

drop policy if exists catalog_read on permissions;
create policy catalog_read on permissions
  for select to authenticated using (true);

drop policy if exists catalog_read on role_permissions;
create policy catalog_read on role_permissions
  for select to authenticated using (true);

-- Solo el superadmin modifica el mapa de permisos.
drop policy if exists org_role_perms_read on organization_role_permissions;
create policy org_role_perms_read on organization_role_permissions
  for select to authenticated
  using (organization_id in (select auth_active_organization_ids()) or is_platform_admin());

drop policy if exists org_role_perms_write on organization_role_permissions;
create policy org_role_perms_write on organization_role_permissions
  for all to authenticated
  using (is_platform_admin())
  with check (is_platform_admin());

drop policy if exists perm_audit_read on permission_audit_log;
create policy perm_audit_read on permission_audit_log
  for select to authenticated
  using (organization_id in (select auth_active_organization_ids()) or is_platform_admin());

drop policy if exists invitations_read on organization_invitations;
create policy invitations_read on organization_invitations
  for select to authenticated
  using (has_permission(organization_id, 'manage_users'));

-- La escritura de invitaciones pasa por el backend: hay que generar y
-- enviar el token, que nunca debe viajar al cliente que invita.


-- =============================================================================
-- BLOQUE 9 — Feature en el catálogo
-- =============================================================================

insert into features (key, name, description, category, has_cost_impact, sort_order)
values ('rbac_access', 'Usuarios y permisos',
        'Invitar usuarios con roles y permisos diferenciados',
        'plataforma', false, 170)
on conflict (key) do nothing;

insert into plan_features (plan_key, feature_key)
select key, 'rbac_access' from plans
on conflict do nothing;


-- =============================================================================
-- BLOQUE 10 — Verificación
-- =============================================================================

-- Mapa efectivo de una organización:
-- select role, permission_key from role_permissions order by 1, 2;

-- Asientos usados contra el límite del plan:
-- select o.name, p.max_users, organization_seats_used(o.id) as usados
-- from organizations o join plans p on p.key = o.plan_key;

-- Organizaciones que exceden su límite (revisar antes de aplicar downgrades):
-- select o.name, p.max_users, organization_seats_used(o.id)
-- from organizations o join plans p on p.key = o.plan_key
-- where organization_seats_used(o.id) > p.max_users;

-- Toda tabla de negocio debe tener RLS activa:
-- select c.relname, c.relrowsecurity from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public' and c.relkind = 'r'
-- order by c.relrowsecurity, c.relname;