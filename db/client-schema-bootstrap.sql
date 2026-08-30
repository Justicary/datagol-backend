-- =============================================================================
-- DATAGOL API — BOOTSTRAP DE BASE DE DATOS PARA CLIENTE (INSTALACIÓN OPERATIVA)
-- =============================================================================
-- Este script es 100% IDEMPOTENTE y está diseñado para inicializar o actualizar
-- el proyecto Supabase / PostgreSQL de un cliente nuevo.
--
-- ⚠️ REGLA DE ARQUITECTURA (AGENTS.md / docs/control-plane-tech-manual.md):
-- Este esquema contiene ÚNICAMENTE las tablas operativas del negocio del cliente.
-- NO incluye ni debe incluir jamás las tablas exclusivas del Plano de Control
-- (customers, deployments, contracts, licenses, provisioning_tasks, deployment_events).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. EXTENSIONES REQUERIDAS
-- -----------------------------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- Función utilitaria para timestamps automáticos
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 1. CATÁLOGOS BASE: PLANES, FEATURES Y PERMISOS RBAC
-- -----------------------------------------------------------------------------

-- Tabla de Características (Features)
create table if not exists public.features (
  key                 text primary key,
  name                text not null,
  description         text,
  category            text not null default 'general',
  is_globally_active  boolean not null default true,
  requires_provider   text check (requires_provider in ('elevenlabs','telnyx','meta','resend','cal','google_maps')),
  has_cost_impact     boolean not null default false,
  created_at          timestamptz not null default now()
);

-- Tabla de Planes
create table if not exists public.plans (
  key                  text primary key,
  name                 text not null,
  description          text,
  price_mxn            numeric(10,2),
  billing_period       text not null default 'mensual' check (billing_period in ('mensual','anual','unico')),
  max_concurrent_calls int not null default 1,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Tabla de Relación Plan - Features
create table if not exists public.plan_features (
  plan_key            text not null references public.plans(key) on delete cascade,
  feature_key         text not null references public.features(key) on delete cascade,
  created_at          timestamptz not null default now(),
  primary key (plan_key, feature_key)
);

-- Tabla de Permisos Granulares (RBAC)
create table if not exists public.permissions (
  key                 text primary key,
  name                text not null,
  description         text,
  category            text not null default 'general',
  created_at          timestamptz not null default now()
);

-- Tabla de Matriz de Permisos por Rol
create table if not exists public.role_permissions (
  role                text not null check (role in ('owner','admin','operator','viewer')),
  permission_key      text not null references public.permissions(key) on delete cascade,
  created_at          timestamptz not null default now(),
  primary key (role, permission_key)
);

-- Planes de ElevenLabs (para concurrencia y límites)
create table if not exists public.elevenlabs_plans (
  key                 text primary key,
  name                text not null,
  concurrency_limit   int not null,
  created_at          timestamptz not null default now()
);

-- Tarifas de Proveedores (para cálculo de costos y metering)
create table if not exists public.provider_rates (
  id                  uuid primary key default gen_random_uuid(),
  provider            text not null,
  unit_type           text not null,
  unit_rate_usd       numeric not null,
  effective_from      timestamptz not null default now(),
  effective_to        timestamptz,
  notes               text,
  created_at          timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 2. GRUPOS DE CREDENCIALES Y ORGANIZACIONES
-- -----------------------------------------------------------------------------

create table if not exists public.credential_groups (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  owner_organization_id  uuid,
  elevenlabs_plan_key    text references public.elevenlabs_plans(key),
  concurrency_override   int check (concurrency_override is null or concurrency_override > 0),
  webhook_token          text unique default encode(gen_random_bytes(24), 'hex'),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table if not exists public.organizations (
  id                            uuid primary key default gen_random_uuid(),
  name                          varchar(255) not null,
  email                         varchar(255) unique not null,
  phone_number                  varchar(50),
  whatsapp_business_account_id  varchar(255),
  whatsapp_phone_number_id      varchar(255),
  cal_event_type_id             int,
  integration_settings          jsonb default '{}'::jsonb,
  active_voice_provider         varchar(50) default 'elevenlabs',
  elevenlabs_agent_id           varchar(255),
  max_concurrent_calls          int default 1,
  silence_timeout_seconds       int default 10,
  max_call_duration_seconds     int default 600,
  kyc_status                    varchar(50) default 'pending',
  plan_key                      text references public.plans(key),
  webhook_token                 text unique default encode(gen_random_bytes(24), 'hex'),
  agent_reprovision_pending     boolean not null default false,
  status                        text not null default 'active' check (status in ('active','suspended','inactive')),
  suspended_reason              text,
  suspended_at                  timestamptz,
  retention_days                int not null default 365,
  timezone                      text not null default 'America/Mexico_City',
  max_mailboxes                 int default 1,
  credential_group_id           uuid references public.credential_groups(id),
  created_at                    timestamptz default now(),
  updated_at                    timestamptz default now()
);

-- FK circular de credential_groups hacia organizations
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints 
    where constraint_name = 'credential_groups_owner_fk'
  ) then
    alter table public.credential_groups
      add constraint credential_groups_owner_fk
      foreign key (owner_organization_id) references public.organizations(id) on delete set null;
  end if;
end $$;

-- Overrides de Features por Organización
create table if not exists public.organization_features (
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  feature_key         text not null references public.features(key) on delete cascade,
  enabled             boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (organization_id, feature_key)
);

-- Miembros de Organización
create table if not exists public.organization_members (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  role                text not null default 'operator' check (role in ('owner','admin','operator','viewer')),
  created_at          timestamptz not null default now(),
  unique (organization_id, user_id)
);

-- Permisos por Rol en Organización (RBAC)
create table if not exists public.organization_role_permissions (
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  role                text not null check (role in ('owner','admin','operator','viewer')),
  permission_key      text not null references public.permissions(key) on delete cascade,
  enabled             boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (organization_id, role, permission_key)
);

-- Permisos por Usuario en Organización
create table if not exists public.organization_user_permissions (
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  permission_key      text not null references public.permissions(key) on delete cascade,
  enabled             boolean not null default true,
  granted_by          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (organization_id, user_id, permission_key)
);

-- Invitaciones a Organización
create table if not exists public.organization_invitations (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  email               text not null,
  role                text not null check (role in ('owner','admin','operator','viewer')),
  invited_by          uuid references auth.users(id),
  token               text not null unique default encode(gen_random_bytes(32), 'hex'),
  expires_at          timestamptz not null default (now() + interval '7 days'),
  accepted_at         timestamptz,
  created_at          timestamptz not null default now()
);

-- Secretos cifrados por Organización
create table if not exists public.organization_secrets (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  secret_key          text not null,
  vault_secret_id     uuid not null,
  rotated_at          timestamptz,
  created_at          timestamptz not null default now(),
  unique (organization_id, secret_key)
);

-- Administradores de Plataforma (Superadmins)
create table if not exists public.platform_admins (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  level               text not null default 'admin' check (level in ('admin','support')),
  created_at          timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 3. CRM, CONTACTOS, DIRECCIONES Y PIPELINE
-- -----------------------------------------------------------------------------

create table if not exists public.contacts (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  phone_e164          text,
  full_name           text,
  email               text,
  business_name       text,
  business_sector     text,
  opted_out           boolean not null default false,
  opted_out_at        timestamptz,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  lifecycle_stage     text not null default 'lead',
  pipeline_stage      text not null default 'nuevo',
  pipeline_updated_at timestamptz not null default now(),
  won_at              timestamptz,
  lost_reason         text,
  archived_at         timestamptz,
  last_activity_at    timestamptz not null default now(),
  deal_value          numeric(12,2),
  deal_currency       text not null default 'MXN',
  deal_notes          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists ux_contacts_org_phone
  on public.contacts (organization_id, phone_e164) where phone_e164 is not null;

create unique index if not exists ux_contacts_org_email
  on public.contacts (organization_id, lower(email)) where email is not null;

create table if not exists public.contact_addresses (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  contact_id          uuid not null references public.contacts(id) on delete cascade,
  label               text not null default 'Domicilio',
  street_address      text not null,
  street_number       text,
  suite_or_interior   text,
  neighborhood        text,
  city                text,
  state               text,
  postal_code         text,
  country             text default 'México',
  latitude            numeric(10,7),
  longitude           numeric(10,7),
  is_default          boolean not null default false,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.contact_notes (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  contact_id          uuid not null references public.contacts(id) on delete cascade,
  author_user_id      uuid references auth.users(id),
  note                text not null,
  created_at          timestamptz not null default now()
);

create table if not exists public.contact_pipeline_transitions (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  contact_id          uuid not null references public.contacts(id) on delete cascade,
  from_stage          text,
  to_stage            text not null,
  changed_by          uuid references auth.users(id),
  reason              text,
  created_at          timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 4. REGISTRO DE LLAMADAS, PROSPECTOS, CITAS Y LISTA DE ESPERA
-- -----------------------------------------------------------------------------

create table if not exists public.call_logs (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid references public.organizations(id) on delete cascade,
  provider_call_id      varchar(255) unique,
  caller_phone          varchar(50),
  agent_phone           varchar(50),
  call_type             varchar(50) default 'inbound',
  duration_seconds      int default 0,
  transcript            text,
  summary               text,
  sentiment             varchar(50),
  status                varchar(50) default 'completed',
  cost                  numeric(10,4) default 0,
  customer_address      text,
  customer_city         varchar(100),
  customer_state        varchar(100),
  customer_zip          varchar(20),
  customer_lat          numeric(10,7),
  customer_lng          numeric(10,7),
  customer_name         varchar(255),
  customer_email        varchar(255),
  contact_id            uuid references public.contacts(id) on delete set null,
  call_summary_sent_at  timestamptz,
  channel               text default 'voice',
  created_at            timestamptz default now()
);

create table ifまん not exists public.leads (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  contact_id            uuid references public.contacts(id) on delete set null,
  channel               text not null default 'voice',
  call_log_id           uuid references public.call_logs(id) on delete set null,
  conversation_id       text,
  full_name             text,
  email                 text,
  contact_phone         text,
  business_name         text,
  business_sector       text,
  inquiry_reason        text,
  plan_of_interest      text,
  call_volume           text,
  booked_appointment    boolean not null default false,
  temperature           text default 'warm',
  needs_followup        boolean not null default false,
  followup_notes        text,
  followup_status       text not null default 'pending',
  followup_at           timestamptz,
  hot_lead_notified_at  timestamptz,
  prospect_summary_sent_at timestamptz,
  source                text,
  source_detail         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists public.appointments (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations(id) on delete cascade,
  call_log_id               uuid references public.call_logs(id) on delete set null,
  customer_name             varchar(255) not null,
  customer_email            varchar(255),
  customer_phone            varchar(50),
  start_time                timestamptz not null,
  end_time                  timestamptz not null,
  cal_booking_id            varchar(255),
  status                    varchar(50) not null default 'agendada',
  service_address           text,
  latitude                  numeric(10,7),
  longitude                 numeric(10,7),
  contact_id                uuid references public.contacts(id) on delete set null,
  conversation_id           text,
  contact_address_id        uuid references public.contact_addresses(id) on delete set null,
  status_updated_at         timestamptz,
  status_updated_by         uuid references auth.users(id),
  no_show_reason            text,
  confirmation_requested_at timestamptz,
  created_at                timestamptz default now()
);

create table if not exists public.appointment_waitlist (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  contact_id          uuid references public.contacts(id) on delete set null,
  customer_name       text not null,
  customer_phone      text not null,
  customer_email      text,
  preferred_days      text[],
  preferred_time_range text,
  status              text not null default 'waiting' check (status in ('waiting','offered','accepted','expired','cancelled')),
  offered_slot_start  timestamptz,
  offered_slot_end    timestamptz,
  offered_at          timestamptz,
  expires_at          timestamptz,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 5. BASE DE CONOCIMIENTO (RAG), ARCHIVOS Y MENSAJERÍA
-- -----------------------------------------------------------------------------

create table if not exists public.knowledge_base (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid references public.organizations(id) on delete cascade,
  title               text not null,
  content             text not null,
  embedding           vector(1536),
  metadata            jsonb default '{}'::jsonb,
  created_at          timestamptz default now()
);

create index if not exists idx_knowledge_base_embedding 
  on public.knowledge_base using hnsw (embedding vector_cosine_ops);

create table if not exists public.whatsapp_messages (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  contact_id          uuid references public.contacts(id) on delete set null,
  message_id          text not null unique,
  direction           text not null check (direction in ('inbound','outbound')),
  status              text not null default 'sent',
  content             text not null,
  category            text default 'service',
  cost_usd            numeric(10,4) default 0,
  created_at          timestamptz not null default now()
);

create table if not exists public.email_accounts (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  email               text not null,
  display_name        text,
  is_default          boolean not null default false,
  created_at          timestamptz not null default now()
);

create table if not exists public.email_outbox (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  account_id          uuid references public.email_accounts(id) on delete set null,
  to_email            text not null,
  subject             text not null,
  body_html           text not null,
  status              text not null default 'pending' check (status in ('pending','sending','sent','failed')),
  error               text,
  sent_at             timestamptz,
  created_at          timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 6. CATÁLOGO DE PRODUCTOS Y SERVICIOS
-- -----------------------------------------------------------------------------

create table if not exists public.catalogs (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  name                text not null,
  description         text,
  is_active           boolean not null default true,
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.products (
  id                  uuid primary key default gen_random_uuid(),
  catalog_id          uuid not null references public.catalogs(id) on delete cascade,
  name                text not null,
  sku                 text,
  description         text,
  category            text,
  base_price_mxn      numeric(12,2) not null default 0,
  image_url           text,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.product_variants (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null references public.products(id) on delete cascade,
  name                text not null,
  sku                 text,
  price_override_mxn  numeric(12,2),
  stock_quantity      int,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 7. AUDITORÍA, METERING Y EVENTOS
-- -----------------------------------------------------------------------------

create table if not exists public.usage_events (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  provider            text not null,
  unit_type           text not null,
  quantity            numeric not null,
  unit_rate_usd       numeric not null,
  amount_usd          numeric,
  conversation_id     text,
  call_log_id         uuid references public.call_logs(id) on delete set null,
  occurred_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  metadata            jsonb not null default '{}'::jsonb,
  idempotency_key     text unique
);

create table if not exists public.permission_audit_log (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid references public.organizations(id) on delete set null,
  role                text,
  permission_key      text,
  action              text not null check (action in ('granted','revoked','expired','role_changed','user_invited','user_removed')),
  previous_value      boolean,
  new_value           boolean,
  target_user_id      uuid references auth.users(id),
  reason              text,
  actor_user_id       uuid references auth.users(id),
  created_at          timestamptz not null default now()
);

create table if not exists public.feature_audit_log (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  feature_key         text not null,
  action              text not null check (action in ('enabled','disabled','overridden','reset')),
  actor_user_id       uuid references auth.users(id),
  reason              text,
  created_at          timestamptz not null default now()
);

create table if not exists public.webhook_events (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid references public.organizations(id) on delete set null,
  provider            text not null,
  event_id            text not null,
  event_type          text,
  raw_payload         jsonb not null default '{}'::jsonb,
  processed_at        timestamptz,
  error               text,
  received_at         timestamptz not null default now(),
  unique (provider, event_id)
);

create table if not exists public.weekly_reports (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  week_start          date not null,
  week_end            date not null,
  status              text not null default 'completed' check (status in ('generating','completed','failed')),
  report_data         jsonb not null default '{}'::jsonb,
  summary_text        text,
  created_at          timestamptz not null default now(),
  unique (organization_id, week_start)
);

-- -----------------------------------------------------------------------------
-- 8. ESTADO DE LICENCIA DEL CLIENTE (MIGRACIÓN 68)
-- -----------------------------------------------------------------------------
-- Tabla singleton (id = true) que almacena la licencia emitida por el plano
-- de control y la bitácora de latidos enviados.

create table if not exists public.license_client_state (
  id                    boolean primary key default true check (id = true),
  deployment_id         uuid,
  deployment_slug       text,
  token                 text,
  key_version           text,
  plan_key              text,
  features              text[] not null default array[]::text[],
  issued_at             timestamptz,
  expires_at            timestamptz,
  warn_after_days       int not null default 7,
  limit_features_after_days int not null default 15,
  lock_dashboard_after_days int not null default 30,
  last_heartbeat_sent_at timestamptz,
  last_heartbeat_ok     boolean,
  last_heartbeat_error  text,
  heartbeat_retry_count int not null default 0,
  updated_at            timestamptz not null default now()
);

insert into public.license_client_state (id) values (true)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- 9. FUNCIONES DE BASE DE DATOS Y RLS
-- -----------------------------------------------------------------------------

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.platform_admins where user_id = auth.uid()
  );
$$;

create or replace function public.auth_organization_id()
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select organization_id from public.organization_members
  where user_id = auth.uid() limit 1;
$$;

-- Habilitar RLS en todas las tablas
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.contacts enable row level security;
alter table public.contact_addresses enable row level security;
alter table public.contact_notes enable row level security;
alter table public.call_logs enable row level security;
alter table public.leads enable row level security;
alter table public.appointments enable row level security;
alter table public.appointment_waitlist enable row level security;
alter table public.knowledge_base enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.catalogs enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.usage_events enable row level security;
alter table public.permission_audit_log enable row level security;
alter table public.feature_audit_log enable row level security;
alter table public.license_client_state enable row level security;

-- Políticas base para miembros de organización
drop policy if exists org_isolation_contacts on public.contacts;
create policy org_isolation_contacts on public.contacts for all to authenticated
  using (organization_id = auth_organization_id() or is_platform_admin())
  with check (organization_id = auth_organization_id() or is_platform_admin());

drop policy if exists org_isolation_call_logs on public.call_logs;
create policy org_isolation_call_logs on public.call_logs for all to authenticated
  using (organization_id = auth_organization_id() or is_platform_admin())
  with check (organization_id = auth_organization_id() or is_platform_admin());

drop policy if exists org_isolation_appointments on public.appointments;
create policy org_isolation_appointments on public.appointments for all to authenticated
  using (organization_id = auth_organization_id() or is_platform_admin())
  with check (organization_id = auth_organization_id() or is_platform_admin());

drop policy if exists org_isolation_leads on public.leads;
create policy org_isolation_leads on public.leads for all to authenticated
  using (organization_id = auth_organization_id() or is_platform_admin())
  with check (organization_id = auth_organization_id() or is_platform_admin());

-- -----------------------------------------------------------------------------
-- 10. SEMILLAS (SEEDS) POR DEFECTO
-- -----------------------------------------------------------------------------

-- Semilla de Planes
insert into public.plans (key, name, description, price_mxn, max_concurrent_calls) values
  ('starter', 'Plan Inicial', 'Ideal para consultorios y negocios con una sola línea de atención', 2500.00, 1),
  ('pro', 'Plan Profesional', 'Hasta 3 llamadas concurrentes con omnicanalidad completa y CRM avanzado', 4500.00, 3),
  ('enterprise', 'Plan Corporativo', 'Llamadas concurrentes ampliadas, integraciones personalizadas y SLA preferente', 8500.00, 10)
on conflict (key) do update set
  name = excluded.name,
  max_concurrent_calls = excluded.max_concurrent_calls;

-- Semilla de Features
insert into public.features (key, name, description, category, requires_provider, has_cost_impact) values
  ('voice_agent', 'Agente de Voz en Vivo', 'Atención telefónica con agente de IA conversacional', 'voz', 'elevenlabs', true),
  ('whatsapp_agent', 'Automatización de WhatsApp', 'Mensajería y seguimiento automatizado en WhatsApp', 'mensajeria', 'meta', true),
  ('calendar_booking', 'Agendamiento Automatizado', 'Consulta y reserva en vivo de citas en Cal.com', 'citas', 'cal', false),
  ('outbound_calls', 'Llamadas Salientes', 'Campañas activas y recordatorios telefónicos automáticos', 'voz', 'telnyx', true),
  ('email_notifications', 'Minutas por Correo', 'Envío de transcripciones y resúmenes ejecutivos vía email', 'notificaciones', 'resend', false),
  ('address_geocoding', 'Geocodificación de Domicilios', 'Validación y geocodificación de coordenadas geográficas', 'geolocalizacion', 'google_maps', true),
  ('product_catalog', 'Catálogo de Productos', 'Consulta de disponibilidad y cotizaciones de servicios', 'catalogo', null, false),
  ('waitlist', 'Lista de Espera Inteligente', 'Reasignación automática de cancelaciones y sobrecupos', 'citas', null, false)
on conflict (key) do nothing;

-- Semilla de Plan Features (starter y pro)
insert into public.plan_features (plan_key, feature_key) values
  ('starter', 'voice_agent'),
  ('starter', 'calendar_booking'),
  ('starter', 'email_notifications'),
  ('pro', 'voice_agent'),
  ('pro', 'whatsapp_agent'),
  ('pro', 'calendar_booking'),
  ('pro', 'outbound_calls'),
  ('pro', 'email_notifications'),
  ('pro', 'address_geocoding'),
  ('pro', 'product_catalog'),
  ('pro', 'waitlist'),
  ('enterprise', 'voice_agent'),
  ('enterprise', 'whatsapp_agent'),
  ('enterprise', 'calendar_booking'),
  ('enterprise', 'outbound_calls'),
  ('enterprise', 'email_notifications'),
  ('enterprise', 'address_geocoding'),
  ('enterprise', 'product_catalog'),
  ('enterprise', 'waitlist')
on conflict do nothing;

-- Semilla de Permisos RBAC
insert into public.permissions (key, name, category) values
  ('contacts.read', 'Ver contactos', 'crm'),
  ('contacts.write', 'Crear y editar contactos', 'crm'),
  ('appointments.read', 'Ver citas de agenda', 'citas'),
  ('appointments.write', 'Gestionar citas', 'citas'),
  ('call_logs.read', 'Ver historial y transcripciones', 'llamadas'),
  ('org.settings', 'Configuración de la organización', 'ajustes'),
  ('org.members', 'Administrar usuarios y accesos', 'usuarios')
on conflict (key) do nothing;

insert into public.role_permissions (role, permission_key) values
  ('owner', 'contacts.read'), ('owner', 'contacts.write'),
  ('owner', 'appointments.read'), ('owner', 'appointments.write'),
  ('owner', 'call_logs.read'), ('owner', 'org.settings'), ('owner', 'org.members'),
  ('admin', 'contacts.read'), ('admin', 'contacts.write'),
  ('admin', 'appointments.read'), ('admin', 'appointments.write'),
  ('admin', 'call_logs.read'), ('admin', 'org.members'),
  ('operator', 'contacts.read'), ('operator', 'contacts.write'),
  ('operator', 'appointments.read'), ('operator', 'appointments.write'),
  ('operator', 'call_logs.read'),
  ('viewer', 'contacts.read'), ('viewer', 'appointments.read'), ('viewer', 'call_logs.read')
on conflict do nothing;
