-- =============================================================================
-- MIGRACIÓN 50 — Corrección de unicidad telefónica en merge_contacts
-- =============================================================================
-- Problema:
-- Al fusionar contactos donde el contacto conservado (p_keep_id) no tenía teléfono
-- y el absorbido (p_absorb_id) sí lo tenía, el UPDATE al contacto conservado
-- intentaba escribir phone_e164 mientras el absorbido aún lo retenía, disparando
-- el error 23505: duplicate key value violates unique constraint "ux_contacts_phone".
--
-- Solución:
-- Guardar en variables PL/pgSQL los datos del absorbido, reasignar dependencias,
-- liberar (phone_e164 = null) y archivar el contacto absorbido PRIMERO,
-- y luego actualizar el contacto conservado con los datos coalescidos.
-- =============================================================================

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
declare
  v_a_full_name       text;
  v_a_email           text;
  v_a_phone_e164      text;
  v_a_business_name   text;
  v_a_business_sector text;
  v_a_first_seen_at   timestamptz;
  v_a_last_seen_at    timestamptz;
  v_a_opted_out       boolean;
begin
  if p_keep_id = p_absorb_id then
    raise exception 'No se puede fusionar un contacto consigo mismo.';
  end if;

  if not exists (select 1 from contacts where id = p_keep_id   and organization_id = p_org_id)
  or not exists (select 1 from contacts where id = p_absorb_id and organization_id = p_org_id) then
    raise exception 'Ambos contactos deben pertenecer a la organización.';
  end if;

  -- 1. Capturar datos del absorbido antes de liberar y reasignar
  select
    full_name, email, phone_e164, business_name, business_sector,
    first_seen_at, last_seen_at, coalesce(opted_out, false)
  into
    v_a_full_name, v_a_email, v_a_phone_e164, v_a_business_name, v_a_business_sector,
    v_a_first_seen_at, v_a_last_seen_at, v_a_opted_out
  from contacts
  where id = p_absorb_id and organization_id = p_org_id;

  -- 2. Reasignar entidades dependientes
  update leads         set contact_id = p_keep_id where contact_id = p_absorb_id;
  update call_logs     set contact_id = p_keep_id where contact_id = p_absorb_id;
  update appointments  set contact_id = p_keep_id where contact_id = p_absorb_id;
  update contact_notes set contact_id = p_keep_id where contact_id = p_absorb_id;

  -- 3. Reasignar direcciones deduplicando
  update contact_addresses set is_primary = false where contact_id = p_absorb_id;

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

  -- 4. Liberar phone_e164 y archivar el absorbido PRIMERO para no violar ux_contacts_phone
  update contacts set
    phone_e164      = null,
    lifecycle_stage = 'descartado',
    archived_at     = now(),
    lost_reason     = 'Fusionado con ' || p_keep_id::text
  where id = p_absorb_id and organization_id = p_org_id;

  -- 5. Actualizar el contacto conservado con los datos coalescidos
  update contacts k set
    full_name       = coalesce(k.full_name,       v_a_full_name),
    email           = coalesce(k.email,           v_a_email),
    phone_e164      = coalesce(k.phone_e164,      v_a_phone_e164),
    business_name   = coalesce(k.business_name,   v_a_business_name),
    business_sector = coalesce(k.business_sector, v_a_business_sector),
    first_seen_at   = least(k.first_seen_at,      v_a_first_seen_at),
    last_seen_at    = greatest(k.last_seen_at,    v_a_last_seen_at),
    opted_out       = k.opted_out or v_a_opted_out
  where k.id = p_keep_id and k.organization_id = p_org_id;
end;
$$;
