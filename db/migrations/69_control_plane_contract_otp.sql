-- =============================================================================
-- Datagol — Migración: Códigos OTP de firma de contrato (CONTROL PLANE)
-- =============================================================================
-- ⚠️ ESTA MIGRACIÓN SE APLICA ÚNICAMENTE EN EL PROYECTO SUPABASE DE
--    api.datagol.net. NUNCA en una instalación de cliente — mismo candado
--    que `55_control_plane_datagol.sql`, del que esta tabla depende
--    (FK a `contracts`).
--
-- `55_control_plane_datagol.sql` ya captura `contracts.verification_method`
-- y `contracts.verified_at`, pero no el código en sí. Igual que
-- `lib/token-hash.ts` para tokens de un solo uso: solo se persiste el hash,
-- nunca el código en claro — el código crudo viaja únicamente por el canal
-- de entrega (correo).
-- =============================================================================

create table if not exists contract_otp_codes (
  id            uuid primary key default gen_random_uuid(),
  contract_id   uuid not null references contracts(id) on delete cascade,

  code_hash     text not null,
  channel       text not null default 'email_otp' check (channel in ('email_otp')),
  sent_to       text not null,             -- correo del firmante al momento del envío

  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  attempts      int not null default 0,

  created_at    timestamptz not null default now()
);

create index if not exists idx_contract_otp_contract
  on contract_otp_codes (contract_id, created_at desc);

-- Un código consumido es evidencia de verificación: no se reescribe.
create or replace function forbid_consumed_otp_mutation()
returns trigger language plpgsql as $$
begin
  if old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at then
    raise exception 'Un código OTP ya consumido no puede modificarse.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_contract_otp_immutable on contract_otp_codes;
create trigger trg_contract_otp_immutable
  before update on contract_otp_codes
  for each row execute function forbid_consumed_otp_mutation();

alter table contract_otp_codes enable row level security;

drop policy if exists platform_admin_only on contract_otp_codes;
create policy platform_admin_only on contract_otp_codes
  for all to authenticated
  using (is_platform_admin())
  with check (is_platform_admin());
