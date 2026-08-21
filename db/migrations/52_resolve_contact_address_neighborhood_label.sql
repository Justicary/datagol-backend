-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 52_resolve_contact_address_neighborhood_label.sql
-- =============================================================================
-- Actualiza la función resolve_contact_address para admitir:
-- 1. `p_neighborhood text default null`: asigna o actualiza la colonia/fraccionamiento
-- 2. `p_label text default null`: asigna la etiqueta visible ('Mi Casa', 'Matriz', etc.)
--    con valor por defecto 'Mi Casa' para direcciones de tipo 'domicilio'.
--
-- Se eliminan primero todos los overloads previos de `resolve_contact_address`
-- para mantener una única firma limpia en pg_proc.
-- =============================================================================

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT oid::regprocedure AS sig
        FROM pg_proc
        WHERE proname = 'resolve_contact_address'
          AND pronamespace = 'public'::regnamespace
    LOOP
        EXECUTE format('DROP FUNCTION %s', r.sig);
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_contact_address(
  p_org_id       uuid,
  p_contact_id   uuid,
  p_street       text,
  p_city         text default null,
  p_state        text default null,
  p_postal_code  text default null,
  p_lat          numeric default null,
  p_lng          numeric default null,
  p_type         text    default 'domicilio',
  p_neighborhood text    default null,
  p_label        text    default null
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id          uuid;
  v_key         text;
  v_is_first    boolean;
  v_final_label text;
BEGIN
  -- Sin calle no hay dirección. No se inventa.
  IF p_street IS NULL OR length(trim(p_street)) = 0 THEN
    RETURN NULL;
  END IF;

  v_final_label := COALESCE(
    NULLIF(trim(p_label), ''),
    CASE
      WHEN coalesce(p_type, 'domicilio') = 'domicilio' THEN 'Mi Casa'
      WHEN p_type = 'matriz' THEN 'Matriz'
      WHEN p_type = 'sucursal' THEN 'Sucursal'
      WHEN p_type = 'facturacion' THEN 'Facturación'
      ELSE initcap(coalesce(p_type, 'domicilio'))
    END
  );

  v_key := lower(regexp_replace(
    coalesce(p_street,'') || '|' || coalesce(p_postal_code,'') || '|' || coalesce(p_city,''),
    '[^a-zA-Z0-9|]', '', 'g'
  ));

  SELECT id INTO v_id
  FROM public.contact_addresses
  WHERE contact_id = p_contact_id AND dedupe_key = v_key AND archived_at IS NULL
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    -- Completa lo que faltaba y actualiza con las coordenadas y datos geocodificados más recientes
    UPDATE public.contact_addresses SET
      label        = COALESCE(contact_addresses.label, v_final_label),
      neighborhood = COALESCE(p_neighborhood, contact_addresses.neighborhood),
      city         = COALESCE(p_city, contact_addresses.city),
      state        = COALESCE(p_state, contact_addresses.state),
      postal_code  = COALESCE(p_postal_code, contact_addresses.postal_code),
      latitude     = COALESCE(p_lat, contact_addresses.latitude),
      longitude    = COALESCE(p_lng, contact_addresses.longitude),
      updated_at   = now()
    WHERE id = v_id;
    RETURN v_id;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.contact_addresses
    WHERE contact_id = p_contact_id AND archived_at IS NULL
  ) INTO v_is_first;

  INSERT INTO public.contact_addresses (
    organization_id, contact_id, label, address_type, is_primary,
    street, neighborhood, city, state, postal_code, latitude, longitude
  ) VALUES (
    p_org_id, p_contact_id, v_final_label, coalesce(p_type, 'domicilio'), v_is_first,
    p_street, p_neighborhood, p_city, p_state, p_postal_code, p_lat, p_lng
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.resolve_contact_address IS
  'Resolución idempotente de direcciones de contacto desde llamadas o citas. '
  'Admite colonia (p_neighborhood), coordenadas (p_lat/p_lng) y etiqueta visible (p_label, '
  'con valor por defecto ''Mi Casa'' para domicilios).';

-- Asegurar que la restricción de identidad permita archivar contactos durante fusiones (merge)
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_identity_present;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_identity_present CHECK (
  phone_e164 IS NOT NULL OR email IS NOT NULL OR archived_at IS NOT NULL
);

