-- =============================================================================
-- Datagol — Migración 64: lista de espera y confirmación masiva (waitlist)
-- =============================================================================
-- docs/tasks/waitlist_confirmacion_masiva.md — Tareas B1-B4. Cola de espera
-- automática para reasignar citas canceladas: el motor de matchmaking
-- (src/services/waitlist-engine.ts) ofrece el cupo liberado por WhatsApp con
-- un enlace de confirmación de un clic (src/routes/public/waitlist-confirmation.ts),
-- con llamada de voz saliente como canal de respaldo. Feature exclusiva de
-- los planes elite/enterprise.
--
-- offer_token_hash guarda el hash SHA-256 del token enviado en el link de
-- WhatsApp — nunca el token crudo (mismo patrón que
-- organization_invitations.token_hash, src/services/invitation-service.ts).
-- Su restricción UNIQUE es la clave de idempotencia del claim en el endpoint
-- público (AGENTS.md §4).
-- =============================================================================

-- 1. Feature y entitlements
insert into features (key, name, description, category, has_cost_impact, sort_order)
values ('waitlist', 'Lista de espera y confirmación masiva',
        'Cola de espera automática para reasignar citas canceladas y confirmación masiva',
        'operacion', false, 190)
on conflict (key) do nothing;

insert into plan_features (plan_key, feature_key) values
  ('elite', 'waitlist'),
  ('enterprise', 'waitlist')
on conflict do nothing;

insert into permissions (key, name, description, category, is_sensitive, sort_order) values
  ('view_waitlist',   'Ver lista de espera',       'Consultar prospectos en cola de espera', 'datos',     false, 180),
  ('manage_waitlist', 'Gestionar lista de espera', 'Ofertar cupos y reevaluar la cola',       'operacion', false, 190)
on conflict (key) do nothing;

insert into role_permissions (role, permission_key) values
  ('viewer', 'view_waitlist'),
  ('member', 'view_waitlist'),
  ('admin',  'view_waitlist'), ('admin',  'manage_waitlist'),
  ('owner',  'view_waitlist'), ('owner',  'manage_waitlist')
on conflict do nothing;

-- 2. Tabla appointment_waitlist
create table if not exists appointment_waitlist (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references organizations(id) on delete cascade,
  contact_id             uuid references contacts(id) on delete set null,
  call_log_id            uuid references call_logs(id) on delete set null,
  conversation_id        text,
  customer_name          text not null,
  customer_phone         text not null,
  customer_email         text,
  party_size             integer not null default 2,
  preferred_date_start   date not null,
  preferred_date_end     date not null,
  preferred_time_start   time,
  preferred_time_end     time,
  status                 text not null default 'pendiente'
      check (status in ('pendiente', 'ofertada', 'confirmada', 'rechazada', 'expirada', 'cancelada')),
  priority               text not null default 'normal'
      check (priority in ('alta', 'normal', 'baja')),
  offered_appointment_id uuid references appointments(id) on delete set null,
  offered_at             timestamptz,
  offer_expires_at       timestamptz,
  offer_token_hash       text unique,
  offer_viewed_at        timestamptz,
  notification_channel   text not null default 'whatsapp'
      check (notification_channel in ('whatsapp', 'voice', 'sms')),
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists idx_waitlist_org_status
  on appointment_waitlist (organization_id, status, priority, created_at);
create index if not exists idx_waitlist_dates
  on appointment_waitlist (organization_id, preferred_date_start, preferred_date_end);

drop trigger if exists trg_appointment_waitlist_updated on appointment_waitlist;
create trigger trg_appointment_waitlist_updated
  before update on appointment_waitlist
  for each row execute function set_updated_at();

-- 3. Row Level Security
alter table appointment_waitlist enable row level security;

drop policy if exists appointment_waitlist_read on appointment_waitlist;
create policy appointment_waitlist_read on appointment_waitlist
  for select to authenticated
  using (has_permission(organization_id, 'view_waitlist'));

drop policy if exists appointment_waitlist_write on appointment_waitlist;
create policy appointment_waitlist_write on appointment_waitlist
  for all to authenticated
  using (has_permission(organization_id, 'manage_waitlist'))
  with check (has_permission(organization_id, 'manage_waitlist'));

comment on table appointment_waitlist is
  'Cola de espera de citas (docs/tasks/waitlist_confirmacion_masiva.md). Matchmaking en src/services/waitlist-engine.ts; confirmación por enlace de un clic en src/routes/public/waitlist-confirmation.ts (offer_token_hash), con voz saliente como respaldo.';
comment on column appointment_waitlist.offer_token_hash is
  'SHA-256 del token crudo enviado en el link de WhatsApp. El token crudo nunca se persiste ni se loguea (ver src/lib/token-hash.ts).';
