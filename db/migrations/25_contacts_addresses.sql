-- =============================================================================
-- Datagol — Migración: Pipeline de prospectos, ciclo de vida y direcciones
-- =============================================================================
-- Principios rectores:
--
--   contacts = la PERSONA. Tiene ciclo de vida y avanza por el pipeline.
--             Es la tarjeta del kanban. Nunca se borra; se archiva.
--
--   leads    = la CONVERSACIÓN. Registro inmutable de qué pasó y en qué canal.
--             Es la bandeja de pendientes. Nunca se borra: es el historial
--             y la base de atribución de costos en usage_events.
--
--   contact_addresses = los LUGARES de esa persona. Matriz, sucursales,
--             domicilio de facturación. Hoy la dirección se captura suelta en
--             call_logs por conversación y nunca se consolida en el contacto,
--             así que el agente la vuelve a preguntar en cada llamada.
--
-- Tres llamadas de la misma persona son UNA tarjeta que avanza, no tres.
-- =============================================================================


-- =============================================================================
-- BLOQUE 1 — Ciclo de vida del contacto
-- =============================================================================

alter table contacts
  add column if not exists lifecycle_stage text not null default 'prospecto'
    check (lifecycle_stage in ('prospecto','cliente','descartado')),

  add column if not exists pipeline_stage text not null default 'nuevo'
    check (pipeline_stage in ('nuevo','contactado','calificado','cita_agendada','ganado','perdido')),

  add column if not exists pipeline_updated_at timestamptz not null default now(),
  add column if not exists won_at        timestamptz,
  add column if not exists lost_reason   text,
  add column if not exists archived_at   timestamptz,
  add column if not exists last_activity_at timestamptz not null default now();

comment on column contacts.lifecycle_stage is
  'prospecto = aún no compra. cliente = ya compró al menos una vez. descartado = fuera del pipeline (spam, no calificado, inactivo).';

comment on column contacts.pipeline_stage is
  'Etapa del kanban. Solo relevante mientras lifecycle_stage = prospecto.';

alter table contacts drop constraint if exists contacts_lifecycle_pipeline_coherent;
alter table contacts add constraint contacts_lifecycle_pipeline_coherent check (
  (lifecycle_stage = 'prospecto' and pipeline_stage in ('nuevo','contactado','calificado','cita_agendada','perdido'))
  or (lifecycle_stage = 'cliente' and pipeline_stage = 'ganado')
  or (lifecycle_stage = 'descartado')
);

create index if not exists idx_contacts_kanban
  on contacts (organization_id, pipeline_stage, pipeline_updated_at desc)
  where lifecycle_stage = 'prospecto' and archived_at is null;

create index if not exists idx_contacts_clientes
  on contacts (organization_id, last_activity_at desc)
  where lifecycle_stage = 'cliente';


-- =============================================================================
-- BLOQUE 2 — Contacto sin teléfono
-- =============================================================================
-- Decisión pendiente desde el diseño original: un lead del widget web puede
-- traer solo correo. Hoy phone_e164 es NOT NULL y esos leads quedan huérfanos
-- de contacto, invisibles en el kanban.

alter table contacts alter column phone_e164 drop not null;

alter table contacts drop constraint if exists contacts_identity_present;
alter table contacts add constraint contacts_identity_present check (
  phone_e164 is not null or email is not null
);

drop index if exists contacts_organization_id_phone_e164_key;
create unique index if not exists ux_contacts_phone
  on contacts (organization_id, phone_e164)
  where phone_e164 is not null;

-- El correo NO es único a propósito: dos personas de una misma familia o
-- negocio comparten correo con frecuencia. Se usa para *sugerir* duplicados,
-- no para fusionar automáticamente.
create index if not exists idx_contacts_email_lookup
  on contacts (organization_id, lower(email))
  where email is not null;


-- =============================================================================
-- BLOQUE 3 — Direcciones del contacto
-- =============================================================================

create table if not exists contact_addresses (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id      uuid not null references contacts(id) on delete cascade,

  -- Etiqueta que el usuario ve y edita: "Matriz", "Sucursal Angelópolis".
  label           text,

  address_type    text not null default 'servicio'
                  check (address_type in ('matriz','sucursal','facturacion','domicilio','servicio')),

  -- Una sola principal por contacto. Es la que el agente propone por defecto
  -- al agendar una cita en sitio.
  is_primary      boolean not null default false,

  street          text not null,
  interior        text,
  neighborhood    text,
  city            text,
  state           text,
  postal_code     text,
  country         text not null default 'MX',

  latitude        numeric,
  longitude       numeric,

  -- Llave de deduplicación: evita que la misma dirección dictada dos veces
  -- genere dos filas.
  dedupe_key      text generated always as (
                    lower(regexp_replace(
                      coalesce(street,'') || '|' || coalesce(postal_code,'') || '|' || coalesce(city,''),
                      '[^a-zA-Z0-9|]', '', 'g'
                    ))
                  ) stored,

  notes           text,
  verified_at     timestamptz,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_addresses_contact
  on contact_addresses (contact_id) where archived_at is null;

create unique index if not exists ux_addresses_dedupe
  on contact_addresses (contact_id, dedupe_key) where archived_at is null;

create unique index if not exists ux_addresses_one_primary
  on contact_addresses (contact_id) where is_primary and archived_at is null;

drop trigger if exists trg_addresses_updated on contact_addresses;
create trigger trg_addresses_updated before update on contact_addresses
  for each row execute function set_updated_at();

-- Al marcar una dirección como principal, desmarca la anterior.
create or replace function enforce_single_primary_address()
returns trigger language plpgsql as $$
begin
  if new.is_primary then
    update contact_addresses
       set is_primary = false
     where contact_id = new.contact_id
       and id <> new.id
       and is_primary;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_addresses_single_primary on contact_addresses;
create trigger trg_addresses_single_primary
  before insert or update of is_primary on contact_addresses
  for each row when (new.is_primary) execute function enforce_single_primary_address();

-- Resolución idempotente desde una conversación. La llama el job que procesa
-- el webhook cuando el agente capturó una dirección.
create or replace function resolve_contact_address(
  p_org_id      uuid,
  p_contact_id  uuid,
  p_street      text,
  p_city        text default null,
  p_state       text default null,
  p_postal_code text default null,
  p_lat         numeric default null,
  p_lng         numeric default null,
  p_type        text    default 'servicio'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id       uuid;
  v_key      text;
  v_is_first boolean;
begin
  -- Sin calle no hay dirección. No se inventa.
  if p_street is null or length(trim(p_street)) = 0 then
    return null;
  end if;

  v_key := lower(regexp_replace(
    coalesce(p_street,'') || '|' || coalesce(p_postal_code,'') || '|' || coalesce(p_city,''),
    '[^a-zA-Z0-9|]', '', 'g'
  ));

  select id into v_id
  from contact_addresses
  where contact_id = p_contact_id and dedupe_key = v_key and archived_at is null
  limit 1;

  if v_id is not null then
    -- Completa solo lo que faltaba. Nunca pisa un dato bueno con uno vacío.
    update contact_addresses set
      city        = coalesce(city, p_city),
      state       = coalesce(state, p_state),
      postal_code = coalesce(postal_code, p_postal_code),
      latitude    = coalesce(latitude, p_lat),
      longitude   = coalesce(longitude, p_lng)
    where id = v_id;
    return v_id;
  end if;

  select not exists (
    select 1 from contact_addresses
    where contact_id = p_contact_id and archived_at is null
  ) into v_is_first;

  insert into contact_addresses (
    organization_id, contact_id, address_type, is_primary,
    street, city, state, postal_code, latitude, longitude
  ) values (
    p_org_id, p_contact_id, p_type, v_is_first,
    p_street, p_city, p_state, p_postal_code, p_lat, p_lng
  )
  returning id into v_id;

  return v_id;
end;
$$;


-- =============================================================================
-- BLOQUE 4 — Citas: referencia más instantánea
-- =============================================================================
-- La cita apunta a la dirección del contacto, pero conserva el texto tal como
-- estaba al agendar. Si el cliente corrige su dirección después, la cita
-- pasada debe seguir mostrando adónde se fue realmente.

alter table appointments
  add column if not exists contact_address_id uuid references contact_addresses(id) on delete set null;

create index if not exists idx_appointments_address
  on appointments (contact_address_id) where contact_address_id is not null;

comment on column appointments.service_address is
  'Instantánea del texto de la dirección al agendar. No se actualiza si el contacto edita su dirección después.';


-- =============================================================================
-- BLOQUE 5 — Resolución de identidad del contacto
-- =============================================================================
-- Orden: teléfono (fuerte) → correo (débil) → contacto nuevo.

create or replace function resolve_contact(
  p_org_id uuid,
  p_phone  text,
  p_email  text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid;
begin
  if p_phone is not null then
    select id into v_contact_id
    from contacts
    where organization_id = p_org_id and phone_e164 = p_phone
    limit 1;
    if v_contact_id is not null then
      return v_contact_id;
    end if;
  end if;

  -- Coincidencia por correo solo si el contacto no tiene teléfono. Evita
  -- fusionar a dos personas distintas que comparten correo pero llaman desde
  -- números diferentes.
  if p_email is not null then
    select id into v_contact_id
    from contacts
    where organization_id = p_org_id
      and lower(email) = lower(p_email)
      and phone_e164 is null
    limit 1;
    if v_contact_id is not null then
      return v_contact_id;
    end if;
  end if;

  insert into contacts (organization_id, phone_e164, email)
  values (p_org_id, p_phone, p_email)
  returning id into v_contact_id;

  return v_contact_id;
end;
$$;

create or replace view v_duplicate_contact_candidates
with (security_invoker = true) as
select
  a.organization_id,
  a.id         as contact_a,
  b.id         as contact_b,
  a.email      as email_compartido,
  a.full_name  as nombre_a,
  b.full_name  as nombre_b,
  a.phone_e164 as telefono_a,
  b.phone_e164 as telefono_b
from contacts a
join contacts b
  on b.organization_id = a.organization_id
 and lower(b.email) = lower(a.email)
 and b.id > a.id
where a.email is not null
  and a.archived_at is null
  and b.archived_at is null;


-- =============================================================================
-- BLOQUE 6 — Notas del contacto
-- =============================================================================
-- Faltaba en el esquema y el CRM la necesita. Append-only.

create table if not exists contact_notes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id      uuid not null references contacts(id) on delete cascade,
  body            text not null check (length(trim(body)) > 0),
  author_user_id  uuid references auth.users(id),
  created_at      timestamptz not null default now()
);

create index if not exists idx_contact_notes_contact
  on contact_notes (contact_id, created_at desc);

create or replace function forbid_note_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'contact_notes es append-only.';
end;
$$;

drop trigger if exists trg_notes_no_update on contact_notes;
create trigger trg_notes_no_update
  before update on contact_notes
  for each row execute function forbid_note_mutation();


-- =============================================================================
-- BLOQUE 7 — Fusión de contactos
-- =============================================================================
-- Debe ir después de contact_notes y contact_addresses: las reasigna.

create or replace function merge_contacts(
  p_org_id    uuid,
  p_keep_id   uuid,
  p_absorb_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_keep_id = p_absorb_id then
    raise exception 'No se puede fusionar un contacto consigo mismo.';
  end if;

  if not exists (select 1 from contacts where id = p_keep_id   and organization_id = p_org_id)
  or not exists (select 1 from contacts where id = p_absorb_id and organization_id = p_org_id) then
    raise exception 'Ambos contactos deben pertenecer a la organización.';
  end if;

  update leads         set contact_id = p_keep_id where contact_id = p_absorb_id;
  update call_logs     set contact_id = p_keep_id where contact_id = p_absorb_id;
  update appointments  set contact_id = p_keep_id where contact_id = p_absorb_id;
  update contact_notes set contact_id = p_keep_id where contact_id = p_absorb_id;

  -- Las direcciones del absorbido pierden la marca de principal para no
  -- chocar con el índice único.
  update contact_addresses set is_primary = false where contact_id = p_absorb_id;

  -- Archiva las que ya existen repetidas en el contacto que se conserva.
  update contact_addresses a set
    archived_at = now(),
    notes       = coalesce(a.notes,'') || ' [duplicada al fusionar contactos]'
  where a.contact_id = p_absorb_id
    and exists (
      select 1 from contact_addresses k
      where k.contact_id = p_keep_id
        and k.dedupe_key = a.dedupe_key
        and k.archived_at is null
    );

  update contact_addresses
     set contact_id = p_keep_id
   where contact_id = p_absorb_id and archived_at is null;

  update contacts k set
    full_name       = coalesce(k.full_name,       a.full_name),
    email           = coalesce(k.email,           a.email),
    phone_e164      = coalesce(k.phone_e164,      a.phone_e164),
    business_name   = coalesce(k.business_name,   a.business_name),
    business_sector = coalesce(k.business_sector, a.business_sector),
    first_seen_at   = least(k.first_seen_at,      a.first_seen_at),
    last_seen_at    = greatest(k.last_seen_at,    a.last_seen_at),
    opted_out       = k.opted_out or a.opted_out
  from contacts a
  where k.id = p_keep_id and a.id = p_absorb_id;

  update contacts set
    lifecycle_stage = 'descartado',
    archived_at     = now(),
    lost_reason     = 'Fusionado con ' || p_keep_id::text
  where id = p_absorb_id;
end;
$$;


-- =============================================================================
-- BLOQUE 8 — Avance automático del pipeline
-- =============================================================================
-- El sistema avanza con señales objetivas. El cierre (ganado/perdido) es
-- siempre decisión humana: solo el negocio sabe si vendió.

create or replace function advance_pipeline_on_lead()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current   text;
  v_lifecycle text;
begin
  if new.contact_id is null then
    return new;
  end if;

  select pipeline_stage, lifecycle_stage
    into v_current, v_lifecycle
  from contacts where id = new.contact_id;

  -- Un cliente existente no regresa al pipeline de prospección.
  if v_lifecycle <> 'prospecto' then
    update contacts set last_activity_at = now() where id = new.contact_id;
    return new;
  end if;

  -- No calificado (spam, proveedor, número equivocado) sale del kanban.
  if new.temperature = 'no_calificado' then
    update contacts set
      lifecycle_stage  = 'descartado',
      archived_at      = now(),
      lost_reason      = 'No calificado',
      last_activity_at = now()
    where id = new.contact_id;
    return new;
  end if;

  update contacts set
    pipeline_stage = case
      when new.booked_appointment then 'cita_agendada'
      when v_current = 'nuevo' and new.temperature in ('caliente','tibio') then 'calificado'
      when v_current = 'nuevo' then 'contactado'
      else v_current
    end,
    pipeline_updated_at = case
      when new.booked_appointment or v_current = 'nuevo' then now()
      else pipeline_updated_at
    end,
    last_activity_at = now(),
    archived_at      = null
  where id = new.contact_id;

  return new;
end;
$$;

drop trigger if exists trg_lead_advances_pipeline on leads;
create trigger trg_lead_advances_pipeline
  after insert on leads
  for each row execute function advance_pipeline_on_lead();


-- =============================================================================
-- BLOQUE 9 — Archivado automático
-- =============================================================================
-- La respuesta al kanban sucio no es borrar: es archivar lo inactivo. Un
-- prospecto sin actividad no es basura, es una oportunidad fría — y si vuelve
-- a llamar, el trigger anterior lo desarchiva solo.

create or replace function archive_stale_prospects()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update contacts set
    archived_at = now(),
    lost_reason = 'Sin actividad'
  where lifecycle_stage = 'prospecto'
    and archived_at is null
    and pipeline_stage in ('nuevo','contactado')
    and last_activity_at < now() - interval '30 days';

  update contacts set
    archived_at = now(),
    lost_reason = 'Sin actividad'
  where lifecycle_stage = 'prospecto'
    and archived_at is null
    and pipeline_stage in ('calificado','cita_agendada')
    and last_activity_at < now() - interval '90 days';
end;
$$;

select cron.schedule(
  'archive-stale-prospects',
  '30 3 * * *',
  $$ select archive_stale_prospects(); $$
);


-- =============================================================================
-- BLOQUE 10 — Vistas del CRM
-- =============================================================================

create or replace view v_pipeline_kanban
with (security_invoker = true) as
select
  c.id, c.organization_id, c.pipeline_stage, c.pipeline_updated_at,
  c.full_name, c.phone_e164, c.email, c.business_name, c.opted_out,
  c.last_activity_at,
  l.channel        as ultimo_canal,
  l.inquiry_reason as ultimo_motivo,
  l.temperature    as ultima_temperatura,
  l.created_at     as ultima_conversacion,
  (select count(*) from leads where contact_id = c.id)              as total_conversaciones,
  (select count(*) from appointments
     where contact_id = c.id and start_time > now())                as citas_proximas,
  (select count(*) from contact_addresses
     where contact_id = c.id and archived_at is null)               as total_direcciones
from contacts c
left join lateral (
  select * from leads where contact_id = c.id order by created_at desc limit 1
) l on true
where c.lifecycle_stage = 'prospecto'
  and c.archived_at is null;

create or replace view v_clientes
with (security_invoker = true) as
select
  c.*,
  (select count(*) from leads where contact_id = c.id)        as total_conversaciones,
  (select count(*) from appointments where contact_id = c.id) as total_citas
from contacts c
where c.lifecycle_stage = 'cliente';

-- Dirección principal por contacto. La que el agente propone al agendar.
create or replace view v_contact_primary_address
with (security_invoker = true) as
select
  a.contact_id, a.id as address_id, a.label, a.address_type,
  a.street, a.interior, a.neighborhood, a.city, a.state, a.postal_code,
  a.latitude, a.longitude
from contact_addresses a
where a.is_primary and a.archived_at is null;


-- =============================================================================
-- BLOQUE 11 — Retiro de campos redundantes
-- =============================================================================
-- leads.pipeline_stage sobra: el pipeline pertenece a la persona, no a la
-- conversación. leads.followup_status se conserva — responde otra pregunta:
-- ¿alguien atendió ESTA conversación? (la bandeja, no el kanban).

alter table leads rename column pipeline_stage to deprecated_pipeline_stage;

-- Los campos de dirección de call_logs quedan como captura cruda de la
-- conversación. Tras verificar el backfill del Bloque 13, se retiran en
-- otra migración:
-- alter table call_logs
--   drop column customer_address, drop column customer_city,
--   drop column customer_state,   drop column customer_zip,
--   drop column customer_lat,     drop column customer_lng;


-- =============================================================================
-- BLOQUE 12 — RLS
-- =============================================================================

alter table contact_notes     enable row level security;
alter table contact_addresses enable row level security;

drop policy if exists tenant_isolation on contact_notes;
create policy tenant_isolation on contact_notes
  for all to authenticated
  using (organization_id in (select auth_active_organization_ids()))
  with check (organization_id in (select auth_active_organization_ids()));

drop policy if exists tenant_isolation on contact_addresses;
create policy tenant_isolation on contact_addresses
  for all to authenticated
  using (organization_id in (select auth_active_organization_ids()))
  with check (organization_id in (select auth_active_organization_ids()));


-- =============================================================================
-- BLOQUE 13 — Backfill
-- =============================================================================

-- 13.1 Etapa del pipeline según historial real
update contacts c set
  pipeline_stage = case
    when exists (select 1 from appointments a where a.contact_id = c.id) then 'cita_agendada'
    when exists (select 1 from leads l where l.contact_id = c.id
                   and l.temperature in ('caliente','tibio'))            then 'calificado'
    when exists (select 1 from leads l where l.contact_id = c.id)        then 'contactado'
    else 'nuevo'
  end,
  last_activity_at = coalesce(
    (select max(created_at) from leads where contact_id = c.id), c.last_seen_at
  ),
  pipeline_updated_at = now()
where c.lifecycle_stage = 'prospecto';

-- 13.2 Descartar quienes solo tienen conversaciones no calificadas
update contacts c set
  lifecycle_stage = 'descartado',
  archived_at     = now(),
  lost_reason     = 'No calificado'
where c.lifecycle_stage = 'prospecto'
  and exists (select 1 from leads l where l.contact_id = c.id)
  and not exists (
    select 1 from leads l
    where l.contact_id = c.id and (l.temperature is distinct from 'no_calificado')
  );

-- 13.3 Direcciones desde call_logs
-- Recupera lo que el agente capturó en conversaciones pasadas y hoy está
-- suelto, sin persistir en el contacto.
insert into contact_addresses (
  organization_id, contact_id, address_type, is_primary,
  street, city, state, postal_code, latitude, longitude, notes
)
select distinct on (
  cl.contact_id,
  lower(regexp_replace(
    coalesce(cl.customer_address,'') || '|' || coalesce(cl.customer_zip,'') || '|' || coalesce(cl.customer_city,''),
    '[^a-zA-Z0-9|]', '', 'g'))
)
  cl.organization_id,
  cl.contact_id,
  'servicio',
  false,
  cl.customer_address,
  cl.customer_city,
  cl.customer_state,
  cl.customer_zip,
  cl.customer_lat,
  cl.customer_lng,
  'Importada del historial de conversaciones'
from call_logs cl
where cl.contact_id is not null
  and cl.customer_address is not null
  and length(trim(cl.customer_address)) > 0
order by
  cl.contact_id,
  lower(regexp_replace(
    coalesce(cl.customer_address,'') || '|' || coalesce(cl.customer_zip,'') || '|' || coalesce(cl.customer_city,''),
    '[^a-zA-Z0-9|]', '', 'g')),
  cl.created_at desc
on conflict do nothing;

-- 13.4 Marcar como principal la más reciente de cada contacto
update contact_addresses a set is_primary = true
where a.id in (
  select distinct on (contact_id) id
  from contact_addresses
  where archived_at is null
  order by contact_id, created_at desc
)
and not exists (
  select 1 from contact_addresses p
  where p.contact_id = a.contact_id and p.is_primary and p.archived_at is null
);

-- 13.5 Vincular citas existentes a su dirección
-- Coincidencia laxa por texto. Las que no empaten quedan sin vincular y se
-- revisan a mano; conservan su instantánea en service_address.
update appointments ap set contact_address_id = ca.id
from contact_addresses ca
where ap.contact_address_id is null
  and ap.contact_id = ca.contact_id
  and ca.archived_at is null
  and ap.service_address is not null
  and length(split_part(ca.dedupe_key, '|', 1)) > 5
  and lower(regexp_replace(ap.service_address, '[^a-zA-Z0-9]', '', 'g'))
      like '%' || split_part(ca.dedupe_key, '|', 1) || '%';


-- =============================================================================
-- BLOQUE 14 — Verificación
-- =============================================================================

-- Distribución del kanban:
-- select pipeline_stage, count(*) from v_pipeline_kanban group by 1;

-- Duplicados de contacto a revisar:
-- select * from v_duplicate_contact_candidates;

-- Contactos sin identidad (no debe devolver filas):
-- select count(*) from contacts where phone_e164 is null and email is null;

-- Cobertura de direcciones importadas:
-- select count(*) as direcciones,
--        count(distinct contact_id) as contactos_con_direccion
-- from contact_addresses where archived_at is null;

-- Contactos con más de una dirección (sucursales detectadas):
-- select contact_id, count(*) from contact_addresses
-- where archived_at is null group by 1 having count(*) > 1;

-- Citas sin dirección vinculada, para revisión manual:
-- select count(*) from appointments
-- where service_address is not null and contact_address_id is null;

-- Direcciones sin principal (no debe devolver filas):
-- select contact_id from contact_addresses where archived_at is null
-- group by contact_id
-- having count(*) filter (where is_primary) = 0;