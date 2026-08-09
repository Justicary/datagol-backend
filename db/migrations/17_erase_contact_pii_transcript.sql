-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Extiende `erase_contact_pii` (migración 11) para purgar también
-- `call_logs.transcript`/`summary` del contacto.
--
-- La migración 11 dejó esto fuera a propósito: "no hay forma confiable de
-- raspar PII de texto libre sin destruir el registro". Esa objeción era
-- sobre RASPADO SELECTIVO (encontrar y quitar solo los fragmentos de PII
-- dentro del texto libre, que en efecto no es confiable). No aplica al
-- borrado COMPLETO del campo (NULL): un titular que ejerce su derecho de
-- cancelación espera que su transcripción desaparezca, no que sobreviva
-- editada. Con la política de retención por tiempo ya en su lugar (migración
-- 18, que hace exactamente este mismo borrado wholesale de forma automática)
-- no hay razón para que el borrado ARCO a solicitud sea menos completo que
-- el borrado automático por plazo vencido.
--
-- `sentiment` NO se toca: es una etiqueta de análisis (positivo/neutral/
-- negativo), no texto libre con PII.
--
-- Mismo encabezado exacto que la migración 11 (CREATE OR REPLACE, sin DROP:
-- la firma no cambia).
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
END;
$$;

COMMENT ON FUNCTION public.erase_contact_pii(uuid) IS
    'Borrado ARCO: anonimiza nombre/email/teléfono/dirección de un contacto en '
    'contacts, leads, call_logs y appointments, purga transcript/summary de '
    'call_logs y redacta el raw_payload de webhook_events asociado. Conserva '
    'contacts.phone_e164 (clave de supresión de opted_out) y todo campo '
    'operativo/de negocio no identificable (duración, costo, sentiment, '
    'followup_notes). Llamado por el propio cliente vía supabase-js con su '
    'JWT o vía POST /api/organizations/:id/contacts/:contactId/erase — '
    'SECURITY DEFINER, verifica pertenencia contra auth_active_organization_ids() '
    'antes de tocar cualquier fila.';
