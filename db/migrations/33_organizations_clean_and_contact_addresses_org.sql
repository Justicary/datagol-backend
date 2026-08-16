-- =============================================================================
-- Datagol — Migración 33: Limpieza de organizations y soporte de direcciones
-- de organización (matriz, sucursales) en contact_addresses
-- =============================================================================
-- Principios rectores:
--
-- 1. `organizations` queda limpia de secretos (ya en Vault / organization_secrets)
--    y de columnas deprecadas de proveedores heredados (Vapi, Telnyx).
-- 2. `contact_addresses` ahora almacena tanto las direcciones de contactos (cuando
--    `contact_id IS NOT NULL`) como las direcciones y sucursales de la propia
--    organización (cuando `contact_id IS NULL`).
-- 3. La dirección principal de la organización (`contact_id IS NULL, is_primary = true`)
--    reemplaza las columnas de dirección estáticas de `organizations`, permitiendo
--    múltiples sucursales y consulta estructurada por tipo (matriz, sucursal, facturación).
-- =============================================================================

-- =============================================================================
-- BLOQUE 1 — Permitir contact_id NULL en contact_addresses
-- =============================================================================

alter table contact_addresses alter column contact_id drop not null;

-- Actualizar índices de deduplicación y unicidad de dirección principal
drop index if exists ux_addresses_dedupe;
create unique index if not exists ux_addresses_dedupe_contact
  on contact_addresses (contact_id, dedupe_key)
  where contact_id is not null and archived_at is null;

create unique index if not exists ux_addresses_dedupe_org
  on contact_addresses (organization_id, dedupe_key)
  where contact_id is null and archived_at is null;

drop index if exists ux_addresses_one_primary;
create unique index if not exists ux_addresses_one_primary_contact
  on contact_addresses (contact_id)
  where contact_id is not null and is_primary and archived_at is null;

create unique index if not exists ux_addresses_one_primary_org
  on contact_addresses (organization_id)
  where contact_id is null and is_primary and archived_at is null;

create index if not exists idx_addresses_organization
  on contact_addresses (organization_id)
  where contact_id is null and archived_at is null;

-- =============================================================================
-- BLOQUE 2 — Trigger enforce_single_primary_address actualizado
-- =============================================================================

create or replace function enforce_single_primary_address()
returns trigger language plpgsql as $$
begin
  if new.is_primary then
    if new.contact_id is not null then
      update contact_addresses
         set is_primary = false
       where contact_id = new.contact_id
         and id <> new.id
         and is_primary;
    else
      update contact_addresses
         set is_primary = false
       where organization_id = new.organization_id
         and contact_id is null
         and id <> new.id
         and is_primary;
    end if;
  end if;
  return new;
end;
$$;

-- =============================================================================
-- BLOQUE 3 — Migración de datos existentes de organizations a contact_addresses
-- =============================================================================

insert into contact_addresses (
  organization_id,
  contact_id,
  label,
  address_type,
  is_primary,
  street,
  city,
  state,
  postal_code,
  latitude,
  longitude
)
select
  o.id,
  null,
  'Matriz',
  'matriz',
  true,
  o.address,
  o.city,
  o.state,
  o.postal_code,
  o.latitude,
  o.longitude
from organizations o
where o.address is not null and length(trim(o.address)) > 0
on conflict do nothing;

-- =============================================================================
-- BLOQUE 4 — Eliminación de columnas obsoletas en organizations
-- =============================================================================

alter table organizations
  drop column if exists address,
  drop column if exists city,
  drop column if exists state,
  drop column if exists postal_code,
  drop column if exists latitude,
  drop column if exists longitude,
  drop column if exists whatsapp_access_token,
  drop column if exists cal_api_key,
  drop column if exists elevenlabs_api_key,
  drop column if exists telnyx_api_key,
  drop column if exists telnyx_phone_number_id,
  drop column if exists telnyx_sip_connection_id,
  drop column if exists deprecated_vapi_agent_id,
  drop column if exists deprecated_vapi_private_key,
  drop column if exists deprecated_vapi_phone_number_id;

comment on table contact_addresses is
  'Direcciones físicas y fiscales. Cuando contact_id no es nulo, pertenece a ese contacto. Cuando contact_id es nulo, representa una sede/sucursal o matriz de la propia organización.';
