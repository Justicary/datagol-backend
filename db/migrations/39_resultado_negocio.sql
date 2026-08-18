-- =============================================================================
-- Datagol — Migración: asistencia a citas, valor de cierre y atribución
-- =============================================================================
-- Cierra los tres huecos que impiden responder la pregunta que decide una
-- renovación: "¿este sistema me está generando dinero?"
--
--   1. appointments.status  — hoy es varchar sin CHECK. Nadie sabe qué
--      contiene. Sin valores definidos no se puede saber si las citas
--      agendadas realmente se cumplen.
--   2. contacts.deal_value  — no existe ningún campo monetario en el
--      esquema. "¿Cuánto vendí?" es hoy incontestable.
--   3. leads.source         — se conoce el canal técnico (voz, WhatsApp,
--      web) pero no de dónde salió el prospecto (anuncio, referido,
--      Google).
--
-- ⚠️ EJECUTAR EL BLOQUE 0 ANTES QUE NADA. El mapeo del Bloque 1 depende
--    de qué valores existan realmente en la base.
-- =============================================================================


-- =============================================================================
-- BLOQUE 0 — Auditoría previa (ejecutar y leer antes de continuar)
-- =============================================================================

-- ¿Qué valores tiene hoy appointments.status?
select coalesce(status, '(null)') as valor, count(*)
from appointments
group by 1
order by 2 desc;

-- Si aparece algún valor que el Bloque 1 no contempla, agrégalo al mapeo
-- antes de ejecutarlo. NO continúes a ciegas.


-- =============================================================================
-- BLOQUE 1 — Estado de la cita
-- =============================================================================

-- 1.1 Normalizar lo existente.
--     Ajusta este mapeo según el resultado del Bloque 0.
update appointments set status = case
  when status is null                                    then 'programada'
  when lower(trim(status)) in ('scheduled','booked','pendiente','agendada','programada')
                                                         then 'programada'
  when lower(trim(status)) in ('confirmed','confirmada')  then 'confirmada'
  when lower(trim(status)) in ('completed','done','completada','atendida')
                                                         then 'completada'
  when lower(trim(status)) in ('no_show','noshow','no_asistio')
                                                         then 'no_asistio'
  when lower(trim(status)) in ('cancelled','canceled','cancelada')
                                                         then 'cancelada'
  when lower(trim(status)) in ('rescheduled','reprogramada')
                                                         then 'reprogramada'
  else 'programada'
end;

-- 1.2 Aplicar la restricción.
alter table appointments alter column status set not null;
alter table appointments alter column status set default 'programada';

alter table appointments drop constraint if exists appointments_status_check;
alter table appointments add constraint appointments_status_check check (
  status in ('programada','confirmada','completada','no_asistio','cancelada','reprogramada')
);

comment on column appointments.status is
  'programada = agendada sin confirmar. confirmada = el cliente confirmó. completada = asistió. no_asistio = no llegó. cancelada / reprogramada = no se llevó a cabo en esa fecha.';

-- 1.3 Trazabilidad de quién marcó la asistencia.
alter table appointments
  add column if not exists status_updated_at   timestamptz,
  add column if not exists status_updated_by   uuid references auth.users(id),
  add column if not exists no_show_reason      text;

create index if not exists idx_appointments_status
  on appointments (organization_id, status, start_time desc);

-- Citas pasadas que siguen sin desenlace: la bandeja de "marca qué pasó".
create index if not exists idx_appointments_pending_outcome
  on appointments (organization_id, start_time desc)
  where status in ('programada','confirmada');


-- =============================================================================
-- BLOQUE 2 — Valor del cierre
-- =============================================================================
-- Se captura a mano al marcar un contacto como ganado. Es el único dato del
-- sistema que no llega solo, y es el que responde "¿cuánto vendí?".

alter table contacts
  add column if not exists deal_value    numeric(12,2) check (deal_value is null or deal_value >= 0),
  add column if not exists deal_currency text not null default 'MXN'
                          check (deal_currency in ('MXN','USD')),
  add column if not exists deal_notes    text;

comment on column contacts.deal_value is
  'Valor del cierre, capturado manualmente por el admin. Opcional: un cierre sin monto sigue siendo un cierre.';

create index if not exists idx_contacts_won
  on contacts (organization_id, won_at desc)
  where lifecycle_stage = 'cliente' and won_at is not null;

-- Coherencia: solo un cliente puede tener valor de cierre.
alter table contacts drop constraint if exists contacts_deal_requires_won;
alter table contacts add constraint contacts_deal_requires_won check (
  deal_value is null or lifecycle_stage = 'cliente'
);

-- LIMITACIÓN CONOCIDA: un contacto tiene un solo valor de cierre. Para un
-- negocio con compras recurrentes (una clínica con varios tratamientos por
-- paciente) esto subestima el valor real. Si el uso lo justifica, la
-- evolución es una tabla `deals` con varias filas por contacto. No se
-- implementa ahora para no construir sobre una suposición.


-- =============================================================================
-- BLOQUE 3 — Atribución de origen
-- =============================================================================
-- El canal técnico (voz, WhatsApp, web) ya se conoce. Esto responde algo
-- distinto: cómo se enteró el prospecto del negocio.

alter table leads
  add column if not exists source text
    check (source is null or source in (
      'anuncio_pagado','busqueda_google','redes_sociales','referido',
      'sitio_web','letrero_fisico','directorio','otro','desconocido'
    )),
  add column if not exists source_detail text;

comment on column leads.source is
  'Cómo se enteró el prospecto del negocio. Nulo en registros anteriores a esta migración; no se infiere.';

comment on column leads.source_detail is
  'Texto libre: nombre de la campaña, quién lo refirió, parámetros UTM del formulario web.';

create index if not exists idx_leads_source
  on leads (organization_id, source, created_at desc)
  where source is not null;

-- Se deja NULO a propósito en los registros existentes. Inventar un origen
-- para datos históricos produciría métricas de atribución falsas.


-- =============================================================================
-- BLOQUE 4 — Vistas de resultado
-- =============================================================================

-- Citas pasadas sin desenlace marcado. Es la bandeja de trabajo del admin:
-- sin esto, "completada" nunca se llena y todo el módulo queda inservible.
create or replace view v_citas_sin_desenlace
with (security_invoker = true) as
select
  a.id, a.organization_id, a.contact_id,
  a.customer_name, a.customer_phone,
  a.start_time, a.status, a.service_address
from appointments a
where a.status in ('programada','confirmada')
  and a.start_time < now()
order by a.start_time desc;

-- Resultado del negocio: la vista que responde si el sistema genera dinero.
create or replace view v_resultado_negocio
with (security_invoker = true) as
select
  c.organization_id,
  date_trunc('month', c.won_at)                       as mes,
  count(*)                                            as clientes_cerrados,
  count(*) filter (where c.deal_value is not null)    as cierres_con_monto,
  sum(c.deal_value)                                   as valor_total,
  avg(c.deal_value)                                   as ticket_promedio,
  min(c.deal_value)                                   as ticket_minimo,
  max(c.deal_value)                                   as ticket_maximo
from contacts c
where c.lifecycle_stage = 'cliente' and c.won_at is not null
group by 1, 2;

-- Cumplimiento de citas: agendadas contra asistidas.
create or replace view v_cumplimiento_citas
with (security_invoker = true) as
select
  organization_id,
  date_trunc('week', start_time)                          as semana,
  count(*)                                                as total,
  count(*) filter (where status = 'completada')           as asistieron,
  count(*) filter (where status = 'no_asistio')           as no_asistieron,
  count(*) filter (where status = 'cancelada')            as canceladas,
  count(*) filter (where status in ('programada','confirmada')
                     and start_time < now())              as sin_marcar
from appointments
group by 1, 2;

-- Atribución de origen, con lo desconocido declarado explícitamente.
create or replace view v_atribucion_origen
with (security_invoker = true) as
select
  l.organization_id,
  coalesce(l.source, 'sin_dato')                       as origen,
  l.channel,
  count(*)                                             as prospectos,
  count(*) filter (where l.booked_appointment)         as agendaron,
  count(distinct l.contact_id)                         as personas
from leads l
group by 1, 2, 3;


-- =============================================================================
-- BLOQUE 5 — Verificación
-- =============================================================================

-- Distribución de estados tras normalizar:
-- select status, count(*) from appointments group by 1 order by 2 desc;

-- Citas pasadas pendientes de marcar (la bandeja inicial del admin):
-- select count(*) from v_citas_sin_desenlace;

-- Cobertura de atribución (será 100% sin dato al inicio, es correcto):
-- select origen, count(*) from v_atribucion_origen group by 1;

-- Contactos ganados sin monto capturado:
-- select count(*) from contacts
-- where lifecycle_stage = 'cliente' and deal_value is null;