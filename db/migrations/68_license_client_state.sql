-- =============================================================================
-- Datagol — Migración: Estado local del cliente de licencia
-- =============================================================================
-- ⚠️ Esta migración se aplica en TODAS las instalaciones (cada instalación
--    cliente y la propia instancia operativa de Datagol). A diferencia de
--    `55_control_plane_datagol.sql`, aquí NO vive nada del registro
--    comercial ni de la emisión de licencias — solo el estado que cada
--    instalación necesita para verificar SU PROPIA licencia localmente,
--    sin red (docs/tasks/control-plane-backend-datagol.md, Fase B.1).
--
-- Fila única (constraint `singleton`): una instalación tiene una sola
-- licencia vigente a la vez. Sin token (fila ausente), la instalación
-- arranca igual en estado degradado máximo — nunca rehúsa arrancar.
-- =============================================================================

create table if not exists license_client_state (
  id                     boolean primary key default true,
  singleton              boolean not null default true check (singleton),

  token                  text,              -- JWT firmado vigente, tal cual lo emitió el control plane
  key_version            text,
  deployment_id          text,              -- id del despliegue en el control plane (claim del token)
  expires_at             timestamptz,

  last_verified_at       timestamptz,       -- última verificación local exitosa (firma + vigencia)
  last_verification_ok   boolean not null default false,

  last_heartbeat_sent_at    timestamptz,
  last_heartbeat_ok         boolean not null default false,
  last_heartbeat_error      text,
  heartbeat_retry_count      int not null default 0,

  updated_at             timestamptz not null default now(),

  constraint ux_license_client_state_singleton unique (singleton)
);

drop trigger if exists trg_license_client_state_updated on license_client_state;
create trigger trg_license_client_state_updated before update on license_client_state
  for each row execute function set_updated_at();

-- Solo el proceso del backend (service role) toca esta tabla. No hay
-- sesión de usuario de organización que deba leerla ni escribirla.
alter table license_client_state enable row level security;

drop policy if exists service_role_only on license_client_state;
create policy service_role_only on license_client_state
  for all to service_role
  using (true)
  with check (true);
