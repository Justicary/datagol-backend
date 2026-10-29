-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 79_quotations_arco_and_user_delete_fixes.sql
-- =============================================================================
-- Dos correcciones a 77_quotations.sql.
--
-- 1) ARCO. Su `CREATE OR REPLACE` de
-- `erase_contact_pii` partió de la versión de la migración 11 y perdió lo que
-- agregó la migración 17 — la purga de `call_logs.transcript`/`summary` y la
-- redacción de `webhook_events.raw_payload`. Desde que se aplicó la 77, un
-- borrado ARCO dejaba la transcripción completa (con nombre, correo y
-- teléfono dictados) en la base. Detectado por __tests__/contacts.test.ts.
--
-- Esta versión es la de la migración 17 íntegra más el bloque de cotizaciones
-- de la 77 (borra el borrador abierto; anonimiza customer_* y el recipient de
-- las entregas, conservando folio e importes).
--
-- 2) Borrado de usuarios. `quotation_events.actor_user_id` referencia
-- `auth.users ON DELETE SET NULL`, pero el trigger append-only rechazaba todo
-- UPDATE — incluido el que la propia base genera para aplicar ese SET NULL.
-- Resultado: un usuario que alguna vez actuó sobre una cotización no se podía
-- borrar de Auth (HTTP 500 en auth.admin.deleteUser). Mismo bug y misma
-- corrección que permission_audit_log en la migración 47: se permite
-- exactamente ese UPDATE y nada más.
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

    -- contacts: phone_e164 se conserva a propósito (ver nota 2 de la migración 11).
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

    -- call_logs: transcript/summary ahora SÍ se purgan (borrado wholesale,
    -- no raspado selectivo — ver nota arriba). duration_seconds, cost,
    -- sentiment, status y demás campos operativos se conservan.
    UPDATE public.call_logs
    SET customer_name = NULL,
        customer_email = NULL,
        customer_address = NULL,
        customer_city = NULL,
        customer_state = NULL,
        customer_zip = NULL,
        customer_lat = NULL,
        customer_lng = NULL,
        caller_phone = NULL,
        transcript = NULL,
        summary = NULL
    WHERE contact_id = p_contact_id;

    -- appointments: customer_name/customer_phone son NOT NULL, ver nota 4 de la migración 11.
    UPDATE public.appointments
    SET customer_name = 'Cliente eliminado (ARCO)',
        customer_email = NULL,
        customer_phone = '+000000000000',
        service_address = NULL,
        latitude = NULL,
        longitude = NULL
    WHERE contact_id = p_contact_id;

    -- webhook_events: el body crudo del webhook contiene el mismo transcript
    -- y los mismos data_collection_results (nombre/correo/teléfono) que las
    -- tablas de arriba, sin tocar por ninguna de esas UPDATE — purgarlas ahí
    -- y dejar el original completo aquí sería letra sin fondo. Se identifica
    -- por conversation_id vía los leads de este contacto (mismo criterio que
    -- usa la migración 18 para la purga por plazo).
    UPDATE public.webhook_events we
    SET raw_payload = jsonb_build_object(
        'purged', true,
        'purged_at', now(),
        'purged_reason', 'arco_erasure',
        'event_type', we.event_type
    )
    FROM public.leads l
    WHERE l.contact_id = p_contact_id
      AND we.event_id = we.event_type || ':' || l.conversation_id;

    -- Cotizaciones (Fase G): eliminar borrador abierto; anonimizar customer_* en cotizaciones
    -- y recipient en quotation_deliveries conservando folio e importes.
    PERFORM set_config('datagol.arco_erase', 'on', true);

    DELETE FROM public.quotations
    WHERE contact_id = p_contact_id
      AND status = 'borrador';

    UPDATE public.quotation_deliveries
    SET recipient = NULL
    WHERE quotation_id IN (
        SELECT id FROM public.quotations WHERE contact_id = p_contact_id
    );

    UPDATE public.quotations
    SET customer_name = 'Cliente eliminado (ARCO)',
        customer_email = NULL,
        customer_phone_e164 = NULL,
        customer_business_name = NULL,
        updated_at = now()
    WHERE contact_id = p_contact_id;

    PERFORM set_config('datagol.arco_erase', '', true);
END;
$$;

COMMENT ON FUNCTION public.erase_contact_pii(uuid) IS
    'Borrado ARCO: anonimiza nombre/email/teléfono/dirección del contacto en contacts, leads, call_logs y appointments; purga transcript/summary de call_logs y redacta el raw_payload de webhook_events; elimina su borrador de cotización y anonimiza customer_* de sus cotizaciones y el recipient de sus entregas (conserva folio e importes). Conserva contacts.phone_e164 (clave de supresión de opted_out). Ver migraciones 11, 17, 77 y 79.';


-- -----------------------------------------------------------------------------
-- 2) quotation_events: permitir solo el SET NULL de actor_user_id
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_quotation_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_status text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Único UPDATE legítimo: el ON DELETE SET NULL de
        -- auth.users → quotation_events.actor_user_id.
        IF OLD.actor_user_id IS NOT NULL
           AND NEW.actor_user_id IS NULL
           AND NEW.id = OLD.id
           AND NEW.organization_id = OLD.organization_id
           AND NEW.quotation_id = OLD.quotation_id
           AND NEW.event_type = OLD.event_type
           AND NEW.conversation_id IS NOT DISTINCT FROM OLD.conversation_id
           AND NEW.payload = OLD.payload
           AND NEW.created_at = OLD.created_at THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'quotation_events es append-only y no permite UPDATE.'
            USING ERRCODE = '23514';
    END IF;

    -- En DELETE: solo se permite si la cotización padre fue eliminada en cascada (borrador o purga de abandonada)
    -- o si está activa la bandera de purga de abandonadas.
    IF current_setting('datagol.purge_abandoned', true) = 'on'
       OR current_setting('datagol.arco_erase', true) = 'on' THEN
        RETURN OLD;
    END IF;

    SELECT q.status INTO v_status
    FROM public.quotations q
    WHERE q.id = OLD.quotation_id;

    IF v_status IS NULL THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'quotation_events es append-only y no permite DELETE directo.'
        USING ERRCODE = '23514';
END;
$$;
