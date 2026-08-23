-- =============================================================================
-- Datagol — Migración: Plano de control (CONTROL PLANE)
-- =============================================================================
-- ⚠️ ESTA MIGRACIÓN SE APLICA ÚNICAMENTE EN EL PROYECTO SUPABASE DE
--    api.datagol.net. NUNCA en una instalación de cliente.
--
-- Separación de responsabilidades:
--   organizations  → inquilino OPERATIVO. Una fila en cada instalación
--                    cliente; una en Datagol (Datagol mismo, que corre a
--                    Yeli). No se usa para el registro comercial.
--   customers      → el negocio contratante (razón social, RFC)
--   deployments    → una instalación vendida
--   contracts      → contrato firmado y su evidencia
--   licenses       → llave de funcionamiento, firmada asimétricamente
--
-- Principio rector de la licencia: NUNCA apaga la atención telefónica.
-- La degradación es por etapas y la voz queda fuera de todas ellas.
--
-- Principio rector del latido: SOLO AGREGADOS. Ningún dato personal de los
-- contactos de los clientes viaja al plano de control. Recibirlos convertiría
-- a Datagol en responsable de tratamiento bajo la LFPDPPP para personas que
-- nunca fueron sus clientes.
-- =============================================================================


-- =============================================================================
-- BLOQUE 1 — Clientes contratantes
-- =============================================================================

create table if not exists customers (
  id                  uuid primary key default gen_random_uuid(),

  legal_name          text not null,          -- razón social
  trade_name          text,                   -- nombre comercial
  rfc                 text,
  tax_regime          text,

  fiscal_address      text,
  fiscal_city         text,
  fiscal_state        text,
  fiscal_postal_code  text,

  contact_name        text not null,
  contact_role        text,
  contact_email       text not null,
  contact_phone_e164  text,

  business_sector     text,
  notes               text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint customers_rfc_format check (
    rfc is null or rfc ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'
  ),
  constraint customers_phone_e164 check (
    contact_phone_e164 is null or contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
  )
);

create unique index if not exists ux_customers_rfc
  on customers (rfc) where rfc is not null;
create index if not exists idx_customers_email
  on customers (lower(contact_email));

drop trigger if exists trg_customers_updated on customers;
create trigger trg_customers_updated before update on customers
  for each row execute function set_updated_at();


-- =============================================================================
-- BLOQUE 2 — Despliegues
-- =============================================================================

create table if not exists deployments (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null references customers(id) on delete restrict,

  -- Identificador legible que se usa en la instalación y en soporte.
  slug                text not null unique
                      check (slug ~ '^[a-z0-9][a-z0-9-]{2,40}$'),

  status              text not null default 'borrador'
                      check (status in ('borrador','contratado','aprovisionando',
                                        'configurando','activo','suspendido','cancelado')),

  plan_key            text not null,
  setup_fee_mxn       numeric(12,2),
  retainer_mxn        numeric(12,2),
  currency            text not null default 'MXN' check (currency in ('MXN','USD')),
  billing_period      text not null default 'mensual'
                      check (billing_period in ('mensual','anual','unico')),

  install_url         text,                   -- https://api.cliente.com
  install_region      text,

  contracted_at       timestamptz,
  activated_at        timestamptz,
  renews_at           timestamptz,
  suspended_at        timestamptz,
  cancelled_at        timestamptz,
  cancellation_reason text,

  -- Token de solo lectura para la página de estatus compartida.
  status_token        text not null unique default encode(gen_random_bytes(24), 'hex'),

  internal_notes      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Uno a uno: un cliente no puede tener dos despliegues vivos a la vez.
-- Si cancela y vuelve a contratar, se crea uno nuevo sin duplicar sus
-- datos fiscales.
create unique index if not exists ux_deployments_active_customer
  on deployments (customer_id)
  where status not in ('cancelado');

create index if not exists idx_deployments_status
  on deployments (status, created_at desc);
create index if not exists idx_deployments_renewal
  on deployments (renews_at) where status = 'activo';

drop trigger if exists trg_deployments_updated on deployments;
create trigger trg_deployments_updated before update on deployments
  for each row execute function set_updated_at();


-- =============================================================================
-- BLOQUE 3 — Contratos
-- =============================================================================
-- La fuerza de una firma electrónica depende de la calidad de la evidencia.
-- Todo lo de aquí es esa evidencia.

create table if not exists contracts (
  id                 uuid primary key default gen_random_uuid(),
  deployment_id      uuid not null references deployments(id) on delete restrict,

  template_version   text not null,
  document_hash      text not null,           -- SHA-256 del PDF exacto firmado
  pdf_storage_path   text,

  signer_name        text not null,
  signer_role        text,
  signer_email       text not null,
  signer_phone_e164  text,

  -- Verificación de identidad por código enviado al firmante.
  verification_method text check (verification_method in ('email_otp','sms_otp','ninguna')),
  verified_at        timestamptz,

  signed_at          timestamptz,
  signer_ip          text,
  signer_user_agent  text,
  signer_geo         jsonb,

  -- Sellado de tiempo conforme a NOM-151, cuando aplique.
  timestamp_authority text,
  timestamp_token     text,

  evidence           jsonb not null default '{}'::jsonb,
  voided_at          timestamptz,
  void_reason        text,

  created_at         timestamptz not null default now()
);

create index if not exists idx_contracts_deployment
  on contracts (deployment_id, created_at desc);

-- Un contrato firmado es evidencia: no se modifica. Para anular se usa
-- voided_at, que sí puede escribirse una vez.
create or replace function forbid_signed_contract_mutation()
returns trigger language plpgsql as $$
begin
  if old.signed_at is not null
     and (new.document_hash is distinct from old.document_hash
       or new.signed_at     is distinct from old.signed_at
       or new.signer_email  is distinct from old.signer_email) then
    raise exception 'Un contrato firmado no puede modificarse. Use voided_at para anularlo.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_contracts_immutable on contracts;
create trigger trg_contracts_immutable
  before update on contracts
  for each row execute function forbid_signed_contract_mutation();


-- =============================================================================
-- BLOQUE 4 — Licencias
-- =============================================================================
-- El token es un JWT firmado con llave privada (EdDSA o RS256). La llave
-- privada vive en el gestor de secretos, NUNCA en esta tabla.
--
-- La instalación verifica la firma LOCALMENTE con la llave pública. No
-- necesita red para saber que su licencia es válida: si api.datagol.net
-- está caído, el cliente sigue atendiendo llamadas.

create table if not exists licenses (
  id                  uuid primary key default gen_random_uuid(),
  deployment_id       uuid not null references deployments(id) on delete restrict,

  token               text not null,          -- JWT firmado, emitido al cliente
  key_version         text not null,          -- versión de la llave de firma
  fingerprint         text,                   -- huella de la instalación

  issued_at           timestamptz not null default now(),
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  revocation_reason   text,

  -- Umbrales de degradación, en días sin latido. La voz nunca se apaga.
  warn_after_days           int not null default 7,
  limit_features_after_days int not null default 15,
  lock_dashboard_after_days int not null default 30,

  last_heartbeat_at   timestamptz,
  created_at          timestamptz not null default now()
);

-- Una sola licencia vigente por despliegue.
create unique index if not exists ux_licenses_active
  on licenses (deployment_id)
  where revoked_at is null;

create index if not exists idx_licenses_expiring
  on licenses (expires_at) where revoked_at is null;
create index if not exists idx_licenses_stale
  on licenses (last_heartbeat_at) where revoked_at is null;

comment on column licenses.token is
  'JWT firmado. Contiene deployment slug, plan, features y expiración. La llave privada vive en el gestor de secretos, jamás en la base.';


-- =============================================================================
-- BLOQUE 5 — Latidos
-- =============================================================================
-- SOLO AGREGADOS. El endpoint debe rechazar cualquier payload que contenga
-- campos de datos personales.

create table if not exists license_heartbeats (
  id                 uuid primary key default gen_random_uuid(),
  license_id         uuid not null references licenses(id) on delete cascade,
  deployment_id      uuid not null references deployments(id) on delete cascade,

  received_at        timestamptz not null default now(),
  installed_version  text,
  source_ip          text,

  -- Salud: estado de servicios, errores agregados, latencia p95.
  health             jsonb not null default '{}'::jsonb,

  -- Métricas agregadas: conteos y consumo en USD. Nunca filas individuales.
  metrics            jsonb not null default '{}'::jsonb,

  constraint heartbeat_no_pii check (
    not (health ?| array['contacts','leads','transcript','phone','email'])
    and not (metrics ?| array['contacts','leads','transcript','phone','email'])
  )
);

create index if not exists idx_heartbeats_license
  on license_heartbeats (license_id, received_at desc);

-- Retención: el detalle de latidos no necesita conservarse indefinidamente.
create or replace function purge_old_heartbeats()
returns void language sql security definer
set search_path = public, pg_temp as $$
  delete from license_heartbeats where received_at < now() - interval '180 days';
$$;

select cron.schedule('purge-old-heartbeats', '0 4 * * 0',
  $$ select purge_old_heartbeats(); $$);


-- =============================================================================
-- BLOQUE 6 — Tareas de provisión
-- =============================================================================
-- Alimenta la página de estatus que ven ambas partes. Los trámites externos
-- (DID mexicano, plantillas de Meta) toman días y son el cuello de botella
-- real del onboarding: el cliente debe ver qué falta y qué depende de él.

create table if not exists provisioning_tasks (
  id              uuid primary key default gen_random_uuid(),
  deployment_id   uuid not null references deployments(id) on delete cascade,

  task_key        text not null,
  label           text not null,
  description     text,

  owner           text not null check (owner in ('datagol','cliente','externo')),
  status          text not null default 'pendiente'
                  check (status in ('pendiente','en_proceso','bloqueada','completada','omitida')),

  is_blocking     boolean not null default true,
  sort_order      int not null default 100,

  blocked_reason  text,
  completed_at    timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (deployment_id, task_key)
);

create index if not exists idx_prov_tasks_deployment
  on provisioning_tasks (deployment_id, sort_order);

drop trigger if exists trg_prov_tasks_updated on provisioning_tasks;
create trigger trg_prov_tasks_updated before update on provisioning_tasks
  for each row execute function set_updated_at();

-- Plantilla de tareas. Se instancia al pasar a 'aprovisionando'.
create table if not exists provisioning_task_templates (
  task_key      text primary key,
  label         text not null,
  description   text,
  owner         text not null check (owner in ('datagol','cliente','externo')),
  is_blocking   boolean not null default true,
  applies_when  text,                          -- feature o plan requerido
  sort_order    int not null default 100
);

insert into provisioning_task_templates (task_key, label, description, owner, is_blocking, sort_order) values
  ('contrato_firmado',    'Contrato firmado',            'Firma electrónica del contrato de servicios',                 'cliente', true,  10),
  ('licencia_emitida',    'Licencia emitida',            'Llave de funcionamiento generada y entregada',                'datagol', true,  20),
  ('infra_desplegada',    'Infraestructura desplegada',  'Contenedores y base de datos del cliente en operación',       'datagol', true,  30),
  ('docs_fiscales',       'Documentación fiscal',        'RFC y comprobante de domicilio para el alta del número',      'cliente', true,  40),
  ('did_solicitado',      'Número telefónico solicitado','Alta del número local ante el proveedor',                     'externo', true,  50),
  ('did_activo',          'Número telefónico activo',    'Número asignado y enrutado al agente',                        'externo', true,  60),
  ('cuentas_proveedores', 'Cuentas de proveedores',      'Credenciales de voz, telefonía y mensajería',                 'cliente', true,  70),
  ('waba_conectada',      'WhatsApp conectado',          'Cuenta de WhatsApp Business vinculada',                       'cliente', false, 80),
  ('plantillas_meta',     'Plantillas aprobadas',        'Plantillas de mensaje aprobadas por Meta (24 a 48 horas)',    'externo', false, 90),
  ('kb_cargada',          'Información del negocio',     'Servicios, precios y horarios cargados en el agente',         'cliente', true,  100),
  ('agente_configurado',  'Agente configurado',          'Voz, saludo y herramientas del agente',                       'datagol', true,  110),
  ('pruebas_aceptacion',  'Pruebas de aceptación',       'Llamadas de prueba validadas con el cliente',                 'datagol', true,  120)
on conflict (task_key) do nothing;


-- =============================================================================
-- BLOQUE 7 — Bitácora del despliegue
-- =============================================================================

create table if not exists deployment_events (
  id             uuid primary key default gen_random_uuid(),
  deployment_id  uuid not null references deployments(id) on delete cascade,
  event_type     text not null
                 check (event_type in ('creado','contratado','licencia_emitida',
                                       'licencia_revocada','estado_cambiado','tarea_completada',
                                       'latido_ausente','renovado','suspendido','cancelado','nota')),
  description    text,
  previous_value text,
  new_value      text,
  actor_user_id  uuid references auth.users(id),
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists idx_deployment_events
  on deployment_events (deployment_id, created_at desc);

create or replace function forbid_deployment_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'deployment_events es append-only.';
end;
$$;

drop trigger if exists trg_dep_events_no_update on deployment_events;
create trigger trg_dep_events_no_update
  before update or delete on deployment_events
  for each row execute function forbid_deployment_event_mutation();


-- =============================================================================
-- BLOQUE 8 — Vistas de operación
-- =============================================================================

-- Salud de la flota: qué instalaciones dejaron de reportar y en qué etapa
-- de degradación están.
create or replace view v_fleet_health
with (security_invoker = true) as
select
  d.id as deployment_id, d.slug, d.status, d.plan_key,
  c.trade_name, c.legal_name,
  l.last_heartbeat_at,
  extract(day from now() - coalesce(l.last_heartbeat_at, l.issued_at))::int as dias_sin_latido,
  case
    when l.revoked_at is not null then 'revocada'
    when l.expires_at < now()     then 'expirada'
    when coalesce(l.last_heartbeat_at, l.issued_at) < now() - (l.lock_dashboard_after_days || ' days')::interval
                                  then 'dashboard_bloqueado'
    when coalesce(l.last_heartbeat_at, l.issued_at) < now() - (l.limit_features_after_days || ' days')::interval
                                  then 'features_limitadas'
    when coalesce(l.last_heartbeat_at, l.issued_at) < now() - (l.warn_after_days || ' days')::interval
                                  then 'aviso'
    else 'normal'
  end as etapa_degradacion,
  l.expires_at
from deployments d
join customers c on c.id = d.customer_id
left join licenses l on l.deployment_id = d.id and l.revoked_at is null
where d.status not in ('cancelado');

-- Avance de provisión, base de la página de estatus compartida.
create or replace view v_provisioning_progress
with (security_invoker = true) as
select
  t.deployment_id,
  count(*)                                                as total,
  count(*) filter (where t.status = 'completada')         as completadas,
  count(*) filter (where t.status = 'bloqueada')          as bloqueadas,
  count(*) filter (where t.status <> 'completada'
                     and t.is_blocking)                   as pendientes_criticas,
  count(*) filter (where t.status <> 'completada'
                     and t.owner = 'cliente')             as pendientes_del_cliente,
  round(100.0 * count(*) filter (where t.status = 'completada') / nullif(count(*),0)) as porcentaje
from provisioning_tasks t
group by t.deployment_id;

-- Ingresos recurrentes contratados.
create or replace view v_recurring_revenue
with (security_invoker = true) as
select
  plan_key,
  currency,
  count(*)              as despliegues_activos,
  sum(retainer_mxn)     as retainer_total,
  avg(retainer_mxn)     as retainer_promedio
from deployments
where status = 'activo'
group by 1, 2;


-- =============================================================================
-- BLOQUE 9 — RLS
-- =============================================================================
-- Todas estas tablas son exclusivas del superadmin de Datagol. Ningún
-- usuario de organización debe verlas.

alter table customers                   enable row level security;
alter table deployments                 enable row level security;
alter table contracts                   enable row level security;
alter table licenses                    enable row level security;
alter table license_heartbeats          enable row level security;
alter table provisioning_tasks          enable row level security;
alter table provisioning_task_templates enable row level security;
alter table deployment_events           enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'customers','deployments','contracts','licenses',
    'license_heartbeats','provisioning_tasks',
    'provisioning_task_templates','deployment_events'
  ] loop
    execute format('drop policy if exists platform_admin_only on %I', t);
    execute format($f$
      create policy platform_admin_only on %I
        for all to authenticated
        using (is_platform_admin())
        with check (is_platform_admin())
    $f$, t);
  end loop;
end $$;

-- La página de estatus compartida NO usa RLS: se sirve desde el backend
-- resolviendo el status_token, sin sesión. Ver el brief.


-- =============================================================================
-- BLOQUE 10 — Verificación
-- =============================================================================

-- Salud de la flota:
-- select slug, trade_name, status, dias_sin_latido, etapa_degradacion
-- from v_fleet_health order by dias_sin_latido desc nulls last;

-- Avance de provisión:
-- select d.slug, p.porcentaje, p.pendientes_del_cliente
-- from v_provisioning_progress p join deployments d on d.id = p.deployment_id;

-- Licencias por vencer en 30 días:
-- select d.slug, l.expires_at from licenses l
-- join deployments d on d.id = l.deployment_id
-- where l.revoked_at is null and l.expires_at < now() + interval '30 days';

-- Ninguna tabla del control plane debe estar sin RLS:
-- select c.relname, c.relrowsecurity from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public' and c.relkind = 'r'
--   and c.relname in ('customers','deployments','contracts','licenses',
--                     'license_heartbeats','provisioning_tasks','deployment_events');