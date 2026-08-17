-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 34_thank_you_automation.sql
-- =============================================================================
-- Agradecimiento automático omnicanal y gestión de adjuntos de organización
-- (docs/tasks/agradecimiento-automatico.md).
--
-- 1. organization_attachments: Almacena metadatos y ruta en Supabase Storage
--    para los documentos (PDF, DOCX, XLSX) que una organización puede adjuntar
--    a sus agradecimientos. Solo un archivo activo por organización a la vez.
--
-- 2. thank_you_sends: Registro de todos los envíos (y omisiones deliberadas)
--    de agradecimiento. Habilita la deduplicación atómica por ventana móvil
--    (default: 30 días) a nivel de base de datos.
--
-- 3. register_thank_you_attempt: Función atómica con bloqueo por fila
--    (FOR UPDATE en contacts) para garantizar que dos eventos o jobs
--    concurrentes del mismo contacto no produzcan un doble envío.
--
-- 4. features: Siembra la clave 'automatic_thank_you' (categoría 'mensajeria').
--
-- 5. provider_rates: Siembra tarifas de plantillas de Meta WhatsApp (utility y
--    marketing para México) para medición de costos en usage_events.
-- =============================================================================

-- =============================================================================
-- BLOQUE 1 — Tabla de adjuntos de organización (organization_attachments)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.organization_attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    storage_path text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    uploaded_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_org_attachments_organization_id
    ON public.organization_attachments (organization_id);

CREATE INDEX IF NOT EXISTS idx_org_attachments_created_at
    ON public.organization_attachments (created_at DESC);

-- Solo un adjunto activo a la vez por organización
CREATE UNIQUE INDEX IF NOT EXISTS ux_org_attachments_active
    ON public.organization_attachments (organization_id)
    WHERE is_active = true AND archived_at IS NULL;

ALTER TABLE public.organization_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.organization_attachments
    FOR ALL
    USING (organization_id IN (SELECT auth_active_organization_ids()))
    WITH CHECK (organization_id IN (SELECT auth_active_organization_ids()));

COMMENT ON TABLE public.organization_attachments IS
    'Documentos (PDF, DOCX, XLSX) cargados por la organización en bucket privado de Supabase Storage para adjuntar a agradecimientos automáticos. Solo uno activo por organización.';

-- Trigger para garantizar que activar un adjunto desactive automáticamente los previos de la misma org
CREATE OR REPLACE FUNCTION public.enforce_single_active_attachment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.is_active = true AND NEW.archived_at IS NULL THEN
        UPDATE public.organization_attachments
           SET is_active = false
         WHERE organization_id = NEW.organization_id
           AND id <> NEW.id
           AND is_active = true
           AND archived_at IS NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_single_active_attachment ON public.organization_attachments;
CREATE TRIGGER trg_enforce_single_active_attachment
    BEFORE INSERT OR UPDATE OF is_active, archived_at ON public.organization_attachments
    FOR EACH ROW
    WHEN (NEW.is_active = true AND NEW.archived_at IS NULL)
    EXECUTE FUNCTION public.enforce_single_active_attachment();

-- =============================================================================
-- BLOQUE 2 — Tabla de envíos de agradecimiento (thank_you_sends)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.thank_you_sends (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
    channel text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
    status text NOT NULL CHECK (status IN ('pendiente', 'enviado', 'fallido', 'omitido')),
    skip_reason text,
    attachment_id uuid REFERENCES public.organization_attachments(id) ON DELETE SET NULL,
    sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_thank_you_sends_org_contact_status_created
    ON public.thank_you_sends (organization_id, contact_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_thank_you_sends_lead_id
    ON public.thank_you_sends (lead_id);

CREATE INDEX IF NOT EXISTS idx_thank_you_sends_created_at
    ON public.thank_you_sends (created_at DESC);

ALTER TABLE public.thank_you_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.thank_you_sends
    FOR ALL
    USING (organization_id IN (SELECT auth_active_organization_ids()))
    WITH CHECK (organization_id IN (SELECT auth_active_organization_ids()));

COMMENT ON TABLE public.thank_you_sends IS
    'Historial de envíos y omisiones de agradecimiento automático. Permite la deduplicación por ventana móvil y diagnóstico de prospectos omitidos.';

-- =============================================================================
-- BLOQUE 3 — Función RPC register_thank_you_attempt (Deduplicación Atómica)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.register_thank_you_attempt(
    p_organization_id uuid,
    p_contact_id uuid,
    p_lead_id uuid,
    p_channel text,
    p_attachment_id uuid DEFAULT NULL,
    p_dedupe_window_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_window_days integer;
    v_existing_send record;
    v_new_send_id uuid;
BEGIN
    v_window_days := COALESCE(NULLIF(p_dedupe_window_days, 0), 30);

    -- 1. Bloqueo de fila sobre el contacto para serializar llamadas concurrentes
    PERFORM 1 FROM public.contacts WHERE id = p_contact_id FOR UPDATE;

    -- 2. Verificar si existe envío previo exitoso o pendiente dentro de la ventana móvil
    SELECT id, created_at, status
      INTO v_existing_send
      FROM public.thank_you_sends
     WHERE organization_id = p_organization_id
       AND contact_id = p_contact_id
       AND status IN ('enviado', 'pendiente')
       AND created_at >= (now() - (v_window_days || ' days')::interval)
     ORDER BY created_at DESC
     LIMIT 1;

    -- 3. Si existe, registrar como omitido con razón y denegar
    IF FOUND THEN
        INSERT INTO public.thank_you_sends (
            organization_id,
            contact_id,
            lead_id,
            channel,
            status,
            skip_reason,
            attachment_id,
            created_at
        ) VALUES (
            p_organization_id,
            p_contact_id,
            p_lead_id,
            p_channel,
            'omitido',
            'en_ventana_deduplicacion',
            p_attachment_id,
            now()
        ) RETURNING id INTO v_new_send_id;

        RETURN jsonb_build_object(
            'allowed', false,
            'send_id', v_new_send_id,
            'skip_reason', 'en_ventana_deduplicacion',
            'existing_send_id', v_existing_send.id,
            'existing_created_at', v_existing_send.created_at
        );
    END IF;

    -- 4. Si no existe, registrar como pendiente para reservar el cupo
    INSERT INTO public.thank_you_sends (
        organization_id,
        contact_id,
        lead_id,
        channel,
        status,
        skip_reason,
        attachment_id,
        created_at
    ) VALUES (
        p_organization_id,
        p_contact_id,
        p_lead_id,
        p_channel,
        'pendiente',
        NULL,
        p_attachment_id,
        now()
    ) RETURNING id INTO v_new_send_id;

    RETURN jsonb_build_object(
        'allowed', true,
        'send_id', v_new_send_id,
        'skip_reason', NULL
    );
END;
$$;

-- =============================================================================
-- BLOQUE 4 — Semilla de Features y Tarifas de Proveedor
-- =============================================================================

INSERT INTO public.features (
    key,
    name,
    description,
    category,
    requires_provider,
    has_cost_impact,
    globally_disabled,
    sort_order
)
VALUES (
    'automatic_thank_you',
    'Agradecimiento automático omnicanal',
    'Envío omnicanal de agradecimiento con adjuntos al captar prospectos (voz, web, WhatsApp).',
    'mensajeria',
    NULL,
    true,
    false,
    (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM public.features)
)
ON CONFLICT (key) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    category = EXCLUDED.category,
    has_cost_impact = EXCLUDED.has_cost_impact;

-- Tarifas de Meta para plantillas de WhatsApp en México
INSERT INTO public.provider_rates (provider, unit_type, unit_rate_usd, effective_from, notes)
VALUES
    ('meta', 'wa_utility_mx', 0.0080, '2026-01-01T00:00:00+00:00', 'Plantilla de utilidad Meta WhatsApp México'),
    ('meta', 'wa_marketing_mx', 0.0436, '2026-01-01T00:00:00+00:00', 'Plantilla de marketing Meta WhatsApp México'),
    ('meta', 'wa_service_mx', 0.0000, '2026-01-01T00:00:00+00:00', 'Mensaje de servicio dentro de ventana 24h Meta WhatsApp México')
ON CONFLICT DO NOTHING;
