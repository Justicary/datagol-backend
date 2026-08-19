-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 48_contact_addresses_default_domicilio.sql
-- =============================================================================
-- Actualiza el valor por defecto de contact_addresses.address_type a 'domicilio'
-- (en lugar de 'servicio') y ajusta la función resolve_contact_address para
-- usar 'domicilio' como valor por defecto en p_type.
-- =============================================================================

ALTER TABLE public.contact_addresses
  ALTER COLUMN address_type SET DEFAULT 'domicilio';

CREATE OR REPLACE FUNCTION public.resolve_contact_address(
  p_org_id      uuid,
  p_contact_id  uuid,
  p_street      text,
  p_city        text default null,
  p_state       text default null,
  p_postal_code text default null,
  p_lat         numeric default null,
  p_lng         numeric default null,
  p_type        text    default 'domicilio'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id       uuid;
  v_key      text;
  v_is_first boolean;
BEGIN
  -- Sin calle no hay dirección. No se inventa.
  IF p_street IS NULL OR length(trim(p_street)) = 0 THEN
    RETURN NULL;
  END IF;

  v_key := lower(regexp_replace(
    coalesce(p_street,'') || '|' || coalesce(p_postal_code,'') || '|' || coalesce(p_city,''),
    '[^a-zA-Z0-9|]', '', 'g'
  ));

  SELECT id INTO v_id
  FROM public.contact_addresses
  WHERE contact_id = p_contact_id AND dedupe_key = v_key AND archived_at IS NULL
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    -- Completa solo lo que faltaba. Nunca pisa un dato bueno con uno vacío.
    UPDATE public.contact_addresses SET
      city        = coalesce(city, p_city),
      state       = coalesce(state, p_state),
      postal_code = coalesce(postal_code, p_postal_code),
      latitude    = coalesce(latitude, p_lat),
      longitude   = coalesce(longitude, p_lng),
      updated_at  = now()
    WHERE id = v_id;
    RETURN v_id;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.contact_addresses
    WHERE contact_id = p_contact_id AND archived_at IS NULL
  ) INTO v_is_first;

  INSERT INTO public.contact_addresses (
    organization_id, contact_id, address_type, is_primary,
    street, city, state, postal_code, latitude, longitude
  ) VALUES (
    p_org_id, p_contact_id, coalesce(p_type, 'domicilio'), v_is_first,
    p_street, p_city, p_state, p_postal_code, p_lat, p_lng
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
