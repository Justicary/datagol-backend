-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- docs/tasks/frontend-implementation.md Fase 8.1 (LFPDPPP) — función de
-- borrado ARCO que el propio cliente (tenant) puede operar desde el
-- dashboard, sin pasar por Datagol.
--
-- 1. Alcance decidido con el usuario tras encontrar que `leads`, `call_logs`
--    y `appointments` guardan copias propias de nombre/email/teléfono del
--    contacto (denormalizadas, no se leen de `contacts` en tiempo real).
--    Borrar solo `contacts` dejaría el nombre y el teléfono visibles en
--    Llamadas, Prospectos y Citas — cumpliría la letra pero no el fondo del
--    derecho de cancelación. Se anonimiza en las cuatro tablas.
--
-- 2. `contacts.phone_e164` NO se toca. Es la clave con la que el sistema
--    reconoce a un contacto que vuelve a llamar y respeta su `opted_out` —
--    borrarlo rompería la supresión de contacto futuro, que es exactamente
--    lo que este mismo derecho (oposición) exige mantener. Solo se limpian
--    los datos de identidad (`full_name`, `email`, `business_name`,
--    `business_sector`) y se fuerza `opted_out = true`.
--
-- 3. `leads.followup_notes`, `call_logs.transcript`/`summary`/`sentiment` y
--    los campos operativos (duración, costo, estado) NO se tocan: son
--    registro de negocio, no identidad estructurada, y no hay forma
--    confiable de raspar PII de texto libre sin destruir el registro.
--
-- 4. `appointments.customer_name` y `customer_phone` son NOT NULL (no se
--    puede simplemente vaciarlos) — placeholder acordado con el usuario:
--    'Cliente eliminado (ARCO)' y '+000000000000'. ⚠️ No hay evidencia de
--    que `customer_phone` tenga un CHECK de formato E.164 como sí lo tiene
--    `contacts.phone_e164`, pero tampoco evidencia de que NO lo tenga —
--    antes de correr esto contra datos reales, probarlo primero contra una
--    fila de prueba. Si el placeholder de teléfono viola un CHECK que no
--    está documentado en docs/db_schema.md, la función completa falla (es
--    una sola transacción implícita) y no deja nada a medias — pero hay que
--    enterarse en una fila de prueba, no en producción.
--
-- 5. Verificación de pertenencia: igual que `create_organization_with_owner`
--    (migración 08), esta función es SECURITY DEFINER — bypassea RLS por
--    diseño, así que la única protección real es el chequeo explícito
--    contra `auth_active_organization_ids()` (migración 10, no
--    `auth_organization_ids()` sin filtrar) — un usuario de una
--    organización suspendida no debe poder borrar datos por ningún camino,
--    ni siquiera este.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.erase_contact_pii(p_contact_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_organization_id uuid;
BEGIN
    SELECT organization_id INTO v_organization_id
    FROM public.contacts
    WHERE id = p_contact_id;

    IF v_organization_id IS NULL THEN
        RAISE EXCEPTION 'Contacto no encontrado';
    END IF;

    IF v_organization_id NOT IN (SELECT auth_active_organization_ids()) THEN
        RAISE EXCEPTION 'No tienes permiso para borrar este contacto';
    END IF;

    -- contacts: phone_e164 se conserva a propósito (ver nota 2 arriba).
    UPDATE public.contacts
    SET full_name = NULL,
        email = NULL,
        business_name = NULL,
        business_sector = NULL,
        opted_out = true,
        opted_out_at = COALESCE(opted_out_at, now()),
        updated_at = now()
    WHERE id = p_contact_id;

    -- leads
    UPDATE public.leads
    SET full_name = NULL,
        email = NULL,
        contact_phone = NULL,
        business_name = NULL,
        updated_at = now()
    WHERE contact_id = p_contact_id;

    -- call_logs
    UPDATE public.call_logs
    SET customer_name = NULL,
        customer_email = NULL,
        customer_address = NULL,
        customer_city = NULL,
        customer_state = NULL,
        customer_zip = NULL,
        customer_lat = NULL,
        customer_lng = NULL,
        caller_phone = NULL
    WHERE contact_id = p_contact_id;

    -- appointments: customer_name/customer_phone son NOT NULL, ver nota 4.
    UPDATE public.appointments
    SET customer_name = 'Cliente eliminado (ARCO)',
        customer_email = NULL,
        customer_phone = '+000000000000',
        service_address = NULL,
        latitude = NULL,
        longitude = NULL
    WHERE contact_id = p_contact_id;
END;
$$;

COMMENT ON FUNCTION public.erase_contact_pii(uuid) IS
    'Borrado ARCO (Fase 8.1): anonimiza nombre/email/teléfono/dirección de un contacto en contacts, leads, call_logs y appointments. Conserva contacts.phone_e164 (clave de supresión de opted_out) y todo campo operativo/de negocio (transcript, summary, duración, costo, followup_notes). Llamado por el propio cliente vía supabase-js con su JWT — SECURITY DEFINER, verifica pertenencia contra auth_active_organization_ids() antes de tocar cualquier fila.';
