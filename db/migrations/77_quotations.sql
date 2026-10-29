-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 77_quotations.sql
-- =============================================================================
-- Sistema de cotizaciones con carrito conversacional por contacto:
--   BLOQUE 1: Extensiones (`pg_trgm`, `pg_cron`) e índices GIN trigram en catálogo.
--   BLOQUE 2: Feature `quotations` y permisos `view_quotations` / `manage_quotations`.
--   BLOQUE 3: Tablas (`quotation_settings`, `quotation_folio_counters`, `quotations`,
--             `quotation_items`, `quotation_deliveries`, `quotation_events`) y RLS
--             de solo lectura para `authenticated`.
--   BLOQUE 4: Máquina de estados, triggers de inmutabilidad y protección de
--             borrador al eliminar contacto.
--   BLOQUE 5: RPCs (`quotation_cart_apply`, `quotation_emit`,
--             `quotation_search_products`, `purge_abandoned_quotations`) y job
--             diario en `pg_cron`.
--   BLOQUE 6: Actualización de `factory_reset_transactional_data()`,
--             `erase_contact_pii()` y bucket privado `quotations`.
-- =============================================================================

-- =============================================================================
-- BLOQUE 1 — Extensiones e índices GIN trigram para búsqueda léxica
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE INDEX IF NOT EXISTS idx_products_name_trgm
    ON public.products USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_keywords_trgm
    ON public.products USING gin (keywords gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_brand_trgm
    ON public.products USING gin (brand gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_variants_sku_trgm
    ON public.product_variants USING gin (sku gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_variants_presentation_trgm
    ON public.product_variants USING gin (presentation gin_trgm_ops);


-- =============================================================================
-- BLOQUE 2 — Feature `quotations` y permisos RBAC
-- =============================================================================

INSERT INTO public.features (key, name, description, category, requires_provider, has_cost_impact, globally_disabled, sort_order)
VALUES (
    'quotations',
    'Cotizaciones',
    'Carrito conversacional por contacto y cotizaciones en PDF con folio enviadas por correo o WhatsApp.',
    'operacion',
    NULL,
    false,
    false,
    70
)
ON CONFLICT (key) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    category = EXCLUDED.category,
    requires_provider = EXCLUDED.requires_provider,
    has_cost_impact = EXCLUDED.has_cost_impact;

INSERT INTO public.plan_features (plan_key, feature_key, enabled) VALUES
    ('starter',    'quotations', false),
    ('pro',        'quotations', true),
    ('elite',      'quotations', true),
    ('enterprise', 'quotations', true)
ON CONFLICT (plan_key, feature_key) DO UPDATE SET
    enabled = EXCLUDED.enabled;

INSERT INTO public.permissions (key, name, description, category, is_sensitive, sort_order) VALUES
    ('view_quotations',   'Ver cotizaciones',       'Consultar carritos, cotizaciones emitidas y su historial',                       'datos',     false, 180),
    ('manage_quotations', 'Gestionar cotizaciones', 'Crear, editar, emitir, enviar, revisar y cambiar el estado de cotizaciones',     'operacion', false, 190)
ON CONFLICT (key) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    category = EXCLUDED.category;

INSERT INTO public.role_permissions (role, permission_key, enabled) VALUES
    ('viewer', 'view_quotations',   true),
    ('member', 'view_quotations',   true),
    ('member', 'manage_quotations', true),
    ('admin',  'view_quotations',   true),
    ('admin',  'manage_quotations', true),
    ('owner',  'view_quotations',   true),
    ('owner',  'manage_quotations', true)
ON CONFLICT (role, permission_key) DO UPDATE SET
    enabled = EXCLUDED.enabled;


-- =============================================================================
-- BLOQUE 3 — Tablas de cotizaciones y RLS de solo lectura
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.quotation_settings (
    organization_id         uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
    folio_prefix            text NOT NULL DEFAULT 'COT'
                            CHECK (folio_prefix ~ '^[A-Z0-9]{1,8}$'),
    validity_days           integer NOT NULL DEFAULT 15
                            CHECK (validity_days >= 1 AND validity_days <= 365),
    cart_ttl_hours          integer NOT NULL DEFAULT 168
                            CHECK (cart_ttl_hours >= 24 AND cart_ttl_hours <= 2160),
    max_items               integer NOT NULL DEFAULT 30
                            CHECK (max_items >= 1 AND max_items <= 200),
    terms_text              text NULL,
    notes_default           text NULL,
    email_sender            text NOT NULL DEFAULT 'auto'
                            CHECK (email_sender IN ('auto', 'resend', 'mailbox')),
    email_account_id        uuid NULL REFERENCES public.email_accounts(id) ON DELETE SET NULL,
    whatsapp_template_name  text NULL,
    updated_at              timestamptz NOT NULL DEFAULT now(),
    updated_by              uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

DROP TRIGGER IF EXISTS trg_quotation_settings_updated ON public.quotation_settings;
CREATE TRIGGER trg_quotation_settings_updated
    BEFORE UPDATE ON public.quotation_settings
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.quotation_folio_counters (
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    year            integer NOT NULL CHECK (year >= 2020 AND year <= 2100),
    last_value      bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, year)
);

CREATE TABLE IF NOT EXISTS public.quotations (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    status                  text NOT NULL DEFAULT 'borrador'
                            CHECK (status IN (
                                'borrador',
                                'abandonada',
                                'emitida',
                                'enviada',
                                'aceptada',
                                'rechazada',
                                'vencida',
                                'cancelada',
                                'convertida'
                            )),
    origin                  text NOT NULL DEFAULT 'agente'
                            CHECK (origin IN ('agente', 'dashboard', 'revision')),
    contact_id              uuid NULL REFERENCES public.contacts(id) ON DELETE SET NULL,
    first_conversation_id   text NULL,
    last_conversation_id    text NULL,
    last_channel            text NULL
                            CHECK (last_channel IS NULL OR last_channel IN ('voz', 'whatsapp', 'web', 'dashboard')),
    customer_name           text NULL,
    customer_email          text NULL,
    customer_phone_e164     text NULL,
    customer_business_name  text NULL,
    folio                   text NULL,
    folio_year              integer NULL,
    folio_number            bigint NULL,
    revision_of_id          uuid NULL REFERENCES public.quotations(id) ON DELETE RESTRICT,
    revision_number         integer NOT NULL DEFAULT 0 CHECK (revision_number >= 0),
    currency                text NOT NULL DEFAULT 'MXN'
                            CHECK (currency IN ('MXN', 'USD')),
    subtotal                numeric(14,2) NOT NULL DEFAULT 0,
    tax_total               numeric(14,2) NOT NULL DEFAULT 0,
    discount_total          numeric(14,2) NOT NULL DEFAULT 0,
    total                   numeric(14,2) NOT NULL DEFAULT 0,
    totals_by_billing       jsonb NOT NULL DEFAULT '[]'::jsonb,
    tax_breakdown           jsonb NOT NULL DEFAULT '[]'::jsonb,
    notes                   text NULL,
    terms_text              text NULL,
    issued_at               timestamptz NULL,
    valid_until             date NULL,
    pdf_storage_path        text NULL,
    pdf_sha256              text NULL,
    pdf_generated_at        timestamptz NULL,
    last_activity_at        timestamptz NOT NULL DEFAULT now(),
    accepted_at             timestamptz NULL,
    rejected_at             timestamptz NULL,
    cancelled_at            timestamptz NULL,
    status_reason           text NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    created_by              uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,

    CONSTRAINT quotations_draft_contact_not_null
        CHECK (status <> 'borrador' OR contact_id IS NOT NULL),
    CONSTRAINT quotations_org_folio_unique
        UNIQUE (organization_id, folio)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_quotations_open_cart_per_contact
    ON public.quotations (organization_id, contact_id)
    WHERE status = 'borrador';

CREATE INDEX IF NOT EXISTS idx_quotations_org_status_issued
    ON public.quotations (organization_id, status, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_quotations_org_contact_created
    ON public.quotations (organization_id, contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quotations_sweep_activity
    ON public.quotations (status, last_activity_at)
    WHERE status IN ('borrador', 'abandonada');

DROP TRIGGER IF EXISTS trg_quotations_updated ON public.quotations;
CREATE TRIGGER trg_quotations_updated
    BEFORE UPDATE ON public.quotations
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.quotation_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quotation_id        uuid NOT NULL REFERENCES public.quotations(id) ON DELETE CASCADE,
    organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    line_number         integer NOT NULL CHECK (line_number >= 1),
    variant_id          uuid NOT NULL,
    product_id          uuid NOT NULL,
    catalog_id          uuid NOT NULL,
    sku                 text NOT NULL,
    external_id         text NULL,
    sat_product_key     text NULL,
    sat_unit_key        text NULL,
    item_type           text NOT NULL DEFAULT 'producto'
                        CHECK (item_type IN ('producto', 'servicio', 'plan')),
    billing_period      text NOT NULL DEFAULT 'unico'
                        CHECK (billing_period IN ('unico', 'mensual', 'anual')),
    product_name        text NOT NULL,
    presentation        text NULL,
    description         text NULL,
    quantity            numeric(12,3) NOT NULL CHECK (quantity > 0),
    unit_price          numeric(14,4) NOT NULL CHECK (unit_price >= 0),
    price_includes_tax  boolean NOT NULL DEFAULT true,
    tax_rate            numeric(5,4) NOT NULL DEFAULT 0.1600
                        CHECK (tax_rate >= 0 AND tax_rate <= 1),
    discount_amount     numeric(14,2) NOT NULL DEFAULT 0
                        CHECK (discount_amount >= 0),
    line_subtotal       numeric(14,2) NOT NULL DEFAULT 0,
    line_tax            numeric(14,2) NOT NULL DEFAULT 0,
    line_total          numeric(14,2) NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT quotation_items_line_number_unique UNIQUE (quotation_id, line_number),
    CONSTRAINT quotation_items_variant_unique UNIQUE (quotation_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_quotation_items_quotation
    ON public.quotation_items (quotation_id, line_number);

CREATE INDEX IF NOT EXISTS idx_quotation_items_org_product
    ON public.quotation_items (organization_id, product_id);

DROP TRIGGER IF EXISTS trg_quotation_items_updated ON public.quotation_items;
CREATE TRIGGER trg_quotation_items_updated
    BEFORE UPDATE ON public.quotation_items
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.quotation_deliveries (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    quotation_id        uuid NOT NULL REFERENCES public.quotations(id) ON DELETE CASCADE,
    channel             text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
    recipient           text NULL,
    status              text NOT NULL DEFAULT 'pendiente'
                        CHECK (status IN ('pendiente', 'enviado', 'error', 'omitido')),
    skip_reason         text NULL,
    error               text NULL,
    provider_message_id text NULL,
    idempotency_key     text NOT NULL,
    attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    sent_at             timestamptz NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT quotation_deliveries_idempotency_unique UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_quotation_deliveries_quotation
    ON public.quotation_deliveries (quotation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.quotation_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    quotation_id    uuid NOT NULL REFERENCES public.quotations(id) ON DELETE CASCADE,
    event_type      text NOT NULL
                    CHECK (event_type IN (
                        'carrito_creado',
                        'carrito_retomado',
                        'partida_agregada',
                        'cantidad_cambiada',
                        'partida_eliminada',
                        'emitida',
                        'precio_cambiado_al_emitir',
                        'pdf_generado',
                        'enviada',
                        'envio_fallido',
                        'aceptada',
                        'rechazada',
                        'vencida',
                        'cancelada',
                        'revisada',
                        'exportada',
                        'abandonada'
                    )),
    actor_user_id   uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    conversation_id text NULL,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quotation_events_quotation
    ON public.quotation_events (quotation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_quotation_events_org_type_created
    ON public.quotation_events (organization_id, event_type, created_at DESC);

-- RLS habilitada en todas las tablas; solo lectura con view_quotations (cero escritura directa desde navegador).
ALTER TABLE public.quotation_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotation_folio_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotations               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotation_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotation_deliveries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotation_events         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quotation_settings_read ON public.quotation_settings;
CREATE POLICY quotation_settings_read ON public.quotation_settings
    FOR SELECT TO authenticated
    USING (public.has_permission(organization_id, 'view_quotations'));

DROP POLICY IF EXISTS quotation_folio_counters_read ON public.quotation_folio_counters;
CREATE POLICY quotation_folio_counters_read ON public.quotation_folio_counters
    FOR SELECT TO authenticated
    USING (public.has_permission(organization_id, 'view_quotations'));

DROP POLICY IF EXISTS quotations_read ON public.quotations;
CREATE POLICY quotations_read ON public.quotations
    FOR SELECT TO authenticated
    USING (public.has_permission(organization_id, 'view_quotations'));

DROP POLICY IF EXISTS quotation_items_read ON public.quotation_items;
CREATE POLICY quotation_items_read ON public.quotation_items
    FOR SELECT TO authenticated
    USING (public.has_permission(organization_id, 'view_quotations'));

DROP POLICY IF EXISTS quotation_deliveries_read ON public.quotation_deliveries;
CREATE POLICY quotation_deliveries_read ON public.quotation_deliveries
    FOR SELECT TO authenticated
    USING (public.has_permission(organization_id, 'view_quotations'));

DROP POLICY IF EXISTS quotation_events_read ON public.quotation_events;
CREATE POLICY quotation_events_read ON public.quotation_events
    FOR SELECT TO authenticated
    USING (public.has_permission(organization_id, 'view_quotations'));


-- =============================================================================
-- BLOQUE 4 — Máquina de estados y triggers de inmutabilidad
-- =============================================================================

CREATE OR REPLACE FUNCTION public.quotation_transition_allowed(p_old text, p_new text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_old = p_new THEN true
        WHEN p_old = 'borrador'   AND p_new IN ('emitida', 'abandonada', 'cancelada') THEN true
        WHEN p_old = 'abandonada' AND p_new IN ('borrador') THEN true
        WHEN p_old = 'emitida'    AND p_new IN ('enviada', 'cancelada', 'vencida', 'aceptada', 'rechazada') THEN true
        WHEN p_old = 'enviada'    AND p_new IN ('aceptada', 'rechazada', 'vencida', 'cancelada') THEN true
        WHEN p_old = 'aceptada'   AND p_new IN ('convertida') THEN true
        ELSE false
    END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_quotation_state_and_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing_draft record;
BEGIN
    IF NOT public.quotation_transition_allowed(OLD.status, NEW.status) THEN
        RAISE EXCEPTION 'Transición de estado de cotización no permitida: % -> %', OLD.status, NEW.status
            USING ERRCODE = '23514';
    END IF;

    -- Invariante 4: Al reabrir una abandonada -> borrador, verificar que no exista otro borrador del contacto.
    -- Si existe otro borrador más antiguo, pasa a abandonada; si el existente es más reciente, esta queda abandonada.
    IF OLD.status = 'abandonada' AND NEW.status = 'borrador' AND NEW.contact_id IS NOT NULL THEN
        SELECT id, last_activity_at INTO v_existing_draft
        FROM public.quotations
        WHERE organization_id = NEW.organization_id
          AND contact_id = NEW.contact_id
          AND status = 'borrador'
          AND id <> NEW.id
        LIMIT 1
        FOR UPDATE;

        IF v_existing_draft.id IS NOT NULL THEN
            IF v_existing_draft.last_activity_at <= COALESCE(NEW.last_activity_at, now()) THEN
                UPDATE public.quotations
                SET status = 'abandonada',
                    updated_at = now()
                WHERE id = v_existing_draft.id;
            ELSE
                NEW.status := 'abandonada';
            END IF;
        END IF;
    END IF;

    -- Invariante 1: Cabecera emitida es inmutable salvo estado, motivo, timestamps de transición,
    -- campos de PDF que estaban nulos, contact_id (ON DELETE SET NULL) o borrado ARCO.
    IF OLD.status NOT IN ('borrador', 'abandonada')
       AND current_setting('datagol.arco_erase', true) IS DISTINCT FROM 'on' THEN
        IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
           OR NEW.origin IS DISTINCT FROM OLD.origin
           OR NEW.folio IS DISTINCT FROM OLD.folio
           OR NEW.folio_year IS DISTINCT FROM OLD.folio_year
           OR NEW.folio_number IS DISTINCT FROM OLD.folio_number
           OR NEW.revision_of_id IS DISTINCT FROM OLD.revision_of_id
           OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
           OR NEW.tax_total IS DISTINCT FROM OLD.tax_total
           OR NEW.discount_total IS DISTINCT FROM OLD.discount_total
           OR NEW.total IS DISTINCT FROM OLD.total
           OR NEW.totals_by_billing IS DISTINCT FROM OLD.totals_by_billing
           OR NEW.tax_breakdown IS DISTINCT FROM OLD.tax_breakdown
           OR NEW.notes IS DISTINCT FROM OLD.notes
           OR NEW.terms_text IS DISTINCT FROM OLD.terms_text
           OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
           OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
           OR NEW.customer_name IS DISTINCT FROM OLD.customer_name
           OR NEW.customer_email IS DISTINCT FROM OLD.customer_email
           OR NEW.customer_phone_e164 IS DISTINCT FROM OLD.customer_phone_e164
           OR NEW.customer_business_name IS DISTINCT FROM OLD.customer_business_name THEN
            RAISE EXCEPTION 'La cotización ya fue emitida y su cabecera e importes son inmutables.'
                USING ERRCODE = '23514';
        END IF;

        IF (OLD.pdf_storage_path IS NOT NULL AND NEW.pdf_storage_path IS DISTINCT FROM OLD.pdf_storage_path)
           OR (OLD.pdf_sha256 IS NOT NULL AND NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256)
           OR (OLD.pdf_generated_at IS NOT NULL AND NEW.pdf_generated_at IS DISTINCT FROM OLD.pdf_generated_at) THEN
            RAISE EXCEPTION 'El PDF de una cotización emitida es inmutable una vez generado.'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_quotations_guard ON public.quotations;
CREATE TRIGGER trg_quotations_guard
    BEFORE UPDATE ON public.quotations
    FOR EACH ROW EXECUTE FUNCTION public.enforce_quotation_state_and_immutability();

CREATE OR REPLACE FUNCTION public.enforce_quotation_items_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_quotation_id uuid;
    v_status text;
BEGIN
    v_quotation_id := COALESCE(NEW.quotation_id, OLD.quotation_id);

    SELECT q.status INTO v_status
    FROM public.quotations q
    WHERE q.id = v_quotation_id;

    -- Si la cotización padre ya no existe (borrado en cascada de borrador o purga de abandonada), permitir DELETE.
    IF v_status IS NULL AND TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    IF TG_OP = 'DELETE'
       AND v_status = 'abandonada'
       AND current_setting('datagol.purge_abandoned', true) = 'on' THEN
        RETURN OLD;
    END IF;

    IF v_status IS DISTINCT FROM 'borrador' THEN
        RAISE EXCEPTION 'Las partidas de una cotización solo pueden modificarse en estado borrador (estado actual: %).', v_status
            USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_quotation_items_guard ON public.quotation_items;
CREATE TRIGGER trg_quotation_items_guard
    BEFORE INSERT OR UPDATE OR DELETE ON public.quotation_items
    FOR EACH ROW EXECUTE FUNCTION public.enforce_quotation_items_immutability();

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

DROP TRIGGER IF EXISTS trg_quotation_events_immutable ON public.quotation_events;
CREATE TRIGGER trg_quotation_events_immutable
    BEFORE UPDATE OR DELETE ON public.quotation_events
    FOR EACH ROW EXECUTE FUNCTION public.enforce_quotation_events_append_only();

-- Si se elimina un contacto directamente, eliminar primero sus carritos en borrador
-- para que ON DELETE SET NULL en quotations.contact_id no viole quotations_draft_contact_not_null.
CREATE OR REPLACE FUNCTION public.cleanup_draft_quotations_before_contact_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM set_config('datagol.arco_erase', 'on', true);
    DELETE FROM public.quotations
    WHERE contact_id = OLD.id
      AND status = 'borrador';
    PERFORM set_config('datagol.arco_erase', '', true);
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_delete_draft_quotations ON public.contacts;
CREATE TRIGGER trg_contacts_delete_draft_quotations
    BEFORE DELETE ON public.contacts
    FOR EACH ROW EXECUTE FUNCTION public.cleanup_draft_quotations_before_contact_delete();


-- =============================================================================
-- BLOQUE 5 — RPCs de carrito, emisión, búsqueda y purga
-- =============================================================================

CREATE OR REPLACE FUNCTION public.quotation_cart_apply(
    p_org_id          uuid,
    p_contact_id      uuid,
    p_conversation_id text,
    p_channel         text,
    p_op              text,
    p_sku             text DEFAULT NULL,
    p_quantity        numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_quotation record;
    v_variant record;
    v_max_items integer := 30;
    v_item_count integer := 0;
    v_existing_item record;
    v_resumed boolean := false;
    v_created boolean := false;
    v_line_number integer;
    v_base numeric(14,2);
    v_tax numeric(14,2);
    v_total numeric(14,2);
    v_gross numeric(14,2);
    v_complement record;
    v_suggested_complement jsonb := NULL;
    v_items jsonb := '[]'::jsonb;
BEGIN
    IF p_op NOT IN ('set', 'remove', 'view') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'errorCode', 'INVALID_OP',
            'message', 'Operación de carrito inválida.'
        );
    END IF;

    SELECT COALESCE(qs.max_items, 30) INTO v_max_items
    FROM public.quotation_settings qs
    WHERE qs.organization_id = p_org_id;
    v_max_items := COALESCE(v_max_items, 30);

    -- 1. Si es 'set' con cantidad > 0, validar primero la variante para no crear un carrito vacío en caso de error.
    IF p_op = 'set' AND COALESCE(p_quantity, 0) > 0 THEN
        IF p_sku IS NULL OR btrim(p_sku) = '' THEN
            RETURN jsonb_build_object(
                'ok', false,
                'errorCode', 'SKU_REQUIRED',
                'message', 'Se requiere el SKU del producto.'
            );
        END IF;

        SELECT * INTO v_variant
        FROM public.resolve_variant_for_org(p_org_id, btrim(p_sku));

        IF v_variant.variant_id IS NULL THEN
            RETURN jsonb_build_object(
                'ok', false,
                'errorCode', 'SKU_NOT_FOUND',
                'message', 'No encontré ese producto en el catálogo.'
            );
        END IF;

        IF NOT COALESCE(v_variant.is_available, false) THEN
            RETURN jsonb_build_object(
                'ok', false,
                'errorCode', 'VARIANT_UNAVAILABLE',
                'productName', v_variant.product_name,
                'message', format('Por el momento %s no está disponible para cotizar.', v_variant.product_name)
            );
        END IF;

        IF v_variant.is_inventoriable AND v_variant.stock_status = 'agotado' THEN
            RETURN jsonb_build_object(
                'ok', false,
                'errorCode', 'OUT_OF_STOCK',
                'productName', v_variant.product_name,
                'message', format('Me aparece agotado %s, por lo que no puedo agregarlo a la cotización.', v_variant.product_name)
            );
        END IF;

        IF v_variant.price IS NULL THEN
            RETURN jsonb_build_object(
                'ok', false,
                'errorCode', 'CUSTOM_PRICE',
                'productName', v_variant.product_name,
                'message', format('%s se cotiza a medida con un asesor y no puede agregarse directamente al carrito.', v_variant.product_name)
            );
        END IF;
    END IF;

    -- 2. Buscar borrador abierto del contacto o su abandonada más reciente.
    SELECT * INTO v_quotation
    FROM public.quotations
    WHERE organization_id = p_org_id
      AND contact_id = p_contact_id
      AND status = 'borrador'
    LIMIT 1
    FOR UPDATE;

    IF v_quotation.id IS NULL THEN
        SELECT * INTO v_quotation
        FROM public.quotations
        WHERE organization_id = p_org_id
          AND contact_id = p_contact_id
          AND status = 'abandonada'
        ORDER BY last_activity_at DESC
        LIMIT 1
        FOR UPDATE;

        IF v_quotation.id IS NOT NULL THEN
            -- Mitigación v1 canal web: view en web solo retoma carritos de web con actividad < 24h
            IF p_op = 'view' AND p_channel = 'web' AND (
                v_quotation.last_channel IS DISTINCT FROM 'web'
                OR v_quotation.last_activity_at < now() - interval '24 hours'
            ) THEN
                RETURN jsonb_build_object(
                    'ok', true,
                    'hasCart', false,
                    'quotationId', NULL,
                    'resumed', false,
                    'webCrossChannelBlocked', true,
                    'items', '[]'::jsonb
                );
            END IF;

            IF p_op = 'remove' OR (p_op = 'set' AND COALESCE(p_quantity, 0) <= 0) THEN
                -- Reabrir para eliminar partida
                UPDATE public.quotations
                SET status = 'borrador',
                    last_conversation_id = COALESCE(p_conversation_id, last_conversation_id),
                    last_channel = COALESCE(p_channel, last_channel),
                    last_activity_at = now(),
                    updated_at = now()
                WHERE id = v_quotation.id
                RETURNING * INTO v_quotation;
                v_resumed := true;
            ELSIF p_op IN ('view', 'set') THEN
                UPDATE public.quotations
                SET status = 'borrador',
                    last_conversation_id = COALESCE(p_conversation_id, last_conversation_id),
                    last_channel = COALESCE(p_channel, last_channel),
                    last_activity_at = now(),
                    updated_at = now()
                WHERE id = v_quotation.id
                RETURNING * INTO v_quotation;
                v_resumed := true;

                INSERT INTO public.quotation_events (organization_id, quotation_id, event_type, conversation_id, payload)
                VALUES (
                    p_org_id,
                    v_quotation.id,
                    'carrito_retomado',
                    p_conversation_id,
                    jsonb_build_object('from_status', 'abandonada', 'channel', p_channel)
                );
            END IF;
        END IF;
    ELSE
        -- Ya existía en borrador: verificar mitigación web en view
        IF p_op = 'view' AND p_channel = 'web' AND (
            v_quotation.last_channel IS DISTINCT FROM 'web'
            OR v_quotation.last_activity_at < now() - interval '24 hours'
        ) THEN
            RETURN jsonb_build_object(
                'ok', true,
                'hasCart', false,
                'quotationId', NULL,
                'resumed', false,
                'webCrossChannelBlocked', true,
                'items', '[]'::jsonb
            );
        END IF;

        IF p_conversation_id IS NOT NULL
           AND v_quotation.last_conversation_id IS NOT NULL
           AND v_quotation.last_conversation_id IS DISTINCT FROM p_conversation_id THEN
            v_resumed := true;
            INSERT INTO public.quotation_events (organization_id, quotation_id, event_type, conversation_id, payload)
            VALUES (
                p_org_id,
                v_quotation.id,
                'carrito_retomado',
                p_conversation_id,
                jsonb_build_object('previous_conversation_id', v_quotation.last_conversation_id, 'channel', p_channel)
            );
        END IF;
    END IF;

    -- Si no hay carrito y la operación es view o remove o set 0, devolver vacío sin crear borrador.
    IF v_quotation.id IS NULL AND (p_op IN ('view', 'remove') OR (p_op = 'set' AND COALESCE(p_quantity, 0) <= 0)) THEN
        RETURN jsonb_build_object(
            'ok', true,
            'hasCart', false,
            'quotationId', NULL,
            'resumed', false,
            'items', '[]'::jsonb
        );
    END IF;

    -- Si es 'set' con cantidad > 0 y no existe borrador, crearlo de forma concurrente-segura.
    IF v_quotation.id IS NULL THEN
        INSERT INTO public.quotations (
            organization_id,
            status,
            origin,
            contact_id,
            first_conversation_id,
            last_conversation_id,
            last_channel,
            currency,
            last_activity_at
        )
        VALUES (
            p_org_id,
            'borrador',
            CASE WHEN p_channel = 'dashboard' THEN 'dashboard' ELSE 'agente' END,
            p_contact_id,
            p_conversation_id,
            p_conversation_id,
            p_channel,
            v_variant.currency,
            now()
        )
        ON CONFLICT (organization_id, contact_id) WHERE status = 'borrador'
        DO UPDATE SET
            last_conversation_id = COALESCE(EXCLUDED.last_conversation_id, public.quotations.last_conversation_id),
            last_channel = COALESCE(EXCLUDED.last_channel, public.quotations.last_channel),
            last_activity_at = now(),
            updated_at = now()
        RETURNING * INTO v_quotation;

        IF NOT EXISTS (
            SELECT 1 FROM public.quotation_events
            WHERE quotation_id = v_quotation.id AND event_type = 'carrito_creado'
        ) THEN
            v_created := true;
            INSERT INTO public.quotation_events (organization_id, quotation_id, event_type, conversation_id, payload)
            VALUES (
                p_org_id,
                v_quotation.id,
                'carrito_creado',
                p_conversation_id,
                jsonb_build_object('channel', p_channel)
            );
        END IF;
    END IF;

    -- 3. Ejecutar la operación sobre las partidas
    IF p_op = 'remove' OR (p_op = 'set' AND COALESCE(p_quantity, 0) <= 0) THEN
        SELECT * INTO v_existing_item
        FROM public.quotation_items
        WHERE quotation_id = v_quotation.id
          AND upper(sku) = upper(btrim(COALESCE(p_sku, '')))
        LIMIT 1;

        IF v_existing_item.id IS NOT NULL THEN
            DELETE FROM public.quotation_items
            WHERE id = v_existing_item.id;

            -- Renumerar line_number consecutivamente
            WITH ordered AS (
                SELECT id, row_number() OVER (ORDER BY line_number ASC, created_at ASC) AS rn
                FROM public.quotation_items
                WHERE quotation_id = v_quotation.id
            )
            UPDATE public.quotation_items qi
            SET line_number = ordered.rn
            FROM ordered
            WHERE qi.id = ordered.id
              AND qi.line_number <> ordered.rn;

            INSERT INTO public.quotation_events (organization_id, quotation_id, event_type, conversation_id, payload)
            VALUES (
                p_org_id,
                v_quotation.id,
                'partida_eliminada',
                p_conversation_id,
                jsonb_build_object('sku', v_existing_item.sku, 'productName', v_existing_item.product_name)
            );
        END IF;
    ELSIF p_op = 'set' AND p_quantity > 0 THEN
        -- Verificar moneda única si ya hay otras partidas en el carrito
        SELECT count(*) INTO v_item_count
        FROM public.quotation_items
        WHERE quotation_id = v_quotation.id;

        IF v_item_count > 0 AND v_quotation.currency IS DISTINCT FROM v_variant.currency THEN
            RETURN jsonb_build_object(
                'ok', false,
                'errorCode', 'MIXED_CURRENCY',
                'currency', v_quotation.currency,
                'attemptedCurrency', v_variant.currency,
                'message', format('Esta cotización está en %s y no puede mezclar partidas en %s.', v_quotation.currency, v_variant.currency)
            );
        ELSIF v_item_count = 0 AND v_quotation.currency IS DISTINCT FROM v_variant.currency THEN
            UPDATE public.quotations
            SET currency = v_variant.currency
            WHERE id = v_quotation.id;
            v_quotation.currency := v_variant.currency;
        END IF;

        SELECT * INTO v_existing_item
        FROM public.quotation_items
        WHERE quotation_id = v_quotation.id
          AND variant_id = v_variant.variant_id
        LIMIT 1;

        IF v_existing_item.id IS NULL AND v_item_count >= v_max_items THEN
            RETURN jsonb_build_object(
                'ok', false,
                'errorCode', 'MAX_ITEMS_EXCEEDED',
                'maxItems', v_max_items,
                'message', format('La cotización alcanzó el máximo de %s partidas.', v_max_items)
            );
        END IF;

        -- Cálculo de importes de la línea (misma regla half-up a 2 decimales que quotation-math.ts)
        IF v_variant.price_includes_tax THEN
            v_total := round(v_variant.price * p_quantity, 2);
            v_base := round(v_total / (1 + v_variant.tax_rate), 2);
            v_tax := v_total - v_base;
        ELSE
            v_base := round(v_variant.price * p_quantity, 2);
            v_tax := round(v_base * v_variant.tax_rate, 2);
            v_total := v_base + v_tax;
        END IF;

        IF v_existing_item.id IS NULL THEN
            SELECT COALESCE(max(line_number), 0) + 1 INTO v_line_number
            FROM public.quotation_items
            WHERE quotation_id = v_quotation.id;

            INSERT INTO public.quotation_items (
                quotation_id,
                organization_id,
                line_number,
                variant_id,
                product_id,
                catalog_id,
                sku,
                external_id,
                sat_product_key,
                sat_unit_key,
                item_type,
                billing_period,
                product_name,
                presentation,
                description,
                quantity,
                unit_price,
                price_includes_tax,
                tax_rate,
                discount_amount,
                line_subtotal,
                line_tax,
                line_total
            )
            VALUES (
                v_quotation.id,
                p_org_id,
                v_line_number,
                v_variant.variant_id,
                v_variant.product_id,
                v_variant.catalog_id,
                v_variant.sku,
                v_variant.external_id,
                v_variant.sat_product_key,
                v_variant.sat_unit_key,
                v_variant.item_type,
                v_variant.billing_period,
                v_variant.product_name,
                v_variant.presentation,
                v_variant.description,
                p_quantity,
                v_variant.price,
                v_variant.price_includes_tax,
                v_variant.tax_rate,
                0,
                v_base,
                v_tax,
                v_total
            );

            INSERT INTO public.quotation_events (organization_id, quotation_id, event_type, conversation_id, payload)
            VALUES (
                p_org_id,
                v_quotation.id,
                'partida_agregada',
                p_conversation_id,
                jsonb_build_object(
                    'sku', v_variant.sku,
                    'productName', v_variant.product_name,
                    'quantity', p_quantity,
                    'unitPrice', v_variant.price
                )
            );
        ELSE
            UPDATE public.quotation_items
            SET quantity = p_quantity,
                unit_price = v_variant.price,
                price_includes_tax = v_variant.price_includes_tax,
                tax_rate = v_variant.tax_rate,
                product_name = v_variant.product_name,
                presentation = v_variant.presentation,
                description = v_variant.description,
                item_type = v_variant.item_type,
                billing_period = v_variant.billing_period,
                sat_product_key = v_variant.sat_product_key,
                sat_unit_key = v_variant.sat_unit_key,
                line_subtotal = v_base,
                line_tax = v_tax,
                line_total = v_total,
                updated_at = now()
            WHERE id = v_existing_item.id;

            IF v_existing_item.quantity IS DISTINCT FROM p_quantity THEN
                INSERT INTO public.quotation_events (organization_id, quotation_id, event_type, conversation_id, payload)
                VALUES (
                    p_org_id,
                    v_quotation.id,
                    'cantidad_cambiada',
                    p_conversation_id,
                    jsonb_build_object(
                        'sku', v_variant.sku,
                        'oldQuantity', v_existing_item.quantity,
                        'newQuantity', p_quantity
                    )
                );
            END IF;
        END IF;

        -- Si se agregó un plan, buscar su complemento sugerido (mantenimiento mensual activo)
        IF v_variant.item_type = 'plan' THEN
            SELECT
                v2.sku,
                p2.name AS product_name,
                v2.presentation,
                COALESCE(ov2.price, v2.price) AS price,
                v2.currency,
                v2.billing_period
            INTO v_complement
            FROM public.products p2
            JOIN public.product_variants v2 ON v2.product_id = p2.id AND v2.catalog_id = p2.catalog_id
            LEFT JOIN public.organization_variant_overrides ov2
                ON ov2.variant_id = v2.id AND ov2.organization_id = p_org_id
            WHERE p2.catalog_id = v_variant.catalog_id
              AND p2.bundle_parent_id = v_variant.product_id
              AND p2.is_active = true
              AND v2.is_active = true
              AND COALESCE(ov2.is_available, true) = true
              AND v2.billing_period = 'mensual'
              AND COALESCE(ov2.price, v2.price) IS NOT NULL
            LIMIT 1;

            IF v_complement.sku IS NOT NULL THEN
                v_suggested_complement := jsonb_build_object(
                    'sku', v_complement.sku,
                    'productName', v_complement.product_name,
                    'presentation', v_complement.presentation,
                    'price', v_complement.price,
                    'currency', v_complement.currency,
                    'billingPeriod', v_complement.billing_period
                );
            END IF;
        END IF;
    END IF;

    -- 4. Actualizar trazabilidad y totales rápidos del borrador
    UPDATE public.quotations q
    SET last_conversation_id = COALESCE(p_conversation_id, q.last_conversation_id),
        last_channel = COALESCE(p_channel, q.last_channel),
        last_activity_at = now(),
        subtotal = COALESCE((SELECT sum(line_subtotal) FROM public.quotation_items WHERE quotation_id = q.id), 0),
        tax_total = COALESCE((SELECT sum(line_tax) FROM public.quotation_items WHERE quotation_id = q.id), 0),
        discount_total = COALESCE((SELECT sum(discount_amount) FROM public.quotation_items WHERE quotation_id = q.id), 0),
        total = COALESCE((SELECT sum(line_total) FROM public.quotation_items WHERE quotation_id = q.id), 0),
        updated_at = now()
    WHERE q.id = v_quotation.id
    RETURNING * INTO v_quotation;

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', qi.id,
                'lineNumber', qi.line_number,
                'variantId', qi.variant_id,
                'productId', qi.product_id,
                'catalogId', qi.catalog_id,
                'sku', qi.sku,
                'externalId', qi.external_id,
                'satProductKey', qi.sat_product_key,
                'satUnitKey', qi.sat_unit_key,
                'itemType', qi.item_type,
                'billingPeriod', qi.billing_period,
                'productName', qi.product_name,
                'presentation', qi.presentation,
                'description', qi.description,
                'quantity', qi.quantity,
                'unitPrice', qi.unit_price,
                'priceIncludesTax', qi.price_includes_tax,
                'taxRate', qi.tax_rate,
                'discountAmount', qi.discount_amount,
                'lineSubtotal', qi.line_subtotal,
                'lineTax', qi.line_tax,
                'lineTotal', qi.line_total
            )
            ORDER BY qi.line_number ASC
        ),
        '[]'::jsonb
    ) INTO v_items
    FROM public.quotation_items qi
    WHERE qi.quotation_id = v_quotation.id;

    RETURN jsonb_build_object(
        'ok', true,
        'hasCart', jsonb_array_length(v_items) > 0,
        'quotationId', v_quotation.id,
        'currency', v_quotation.currency,
        'resumed', v_resumed,
        'created', v_created,
        'items', v_items,
        'suggestedComplement', v_suggested_complement
    );
END;
$$;

REVOKE ALL ON FUNCTION public.quotation_cart_apply(uuid, uuid, text, text, text, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quotation_cart_apply(uuid, uuid, text, text, text, text, numeric) TO service_role;


CREATE OR REPLACE FUNCTION public.quotation_emit(
    p_org_id       uuid,
    p_quotation_id uuid,
    p_customer     jsonb,
    p_totals       jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_q record;
    v_item record;
    v_resolved record;
    v_price_changes jsonb := '[]'::jsonb;
    v_prefix text := 'COT';
    v_terms_default text;
    v_notes_default text;
    v_validity_days integer := 15;
    v_tz text := 'America/Mexico_City';
    v_year integer;
    v_folio_number bigint;
    v_folio text;
    v_root_q record;
    v_items_count integer := 0;
    v_sum_subtotal numeric(14,2);
    v_sum_tax numeric(14,2);
    v_sum_discount numeric(14,2);
    v_sum_total numeric(14,2);
    v_in_subtotal numeric(14,2);
    v_in_tax numeric(14,2);
    v_in_discount numeric(14,2);
    v_in_total numeric(14,2);
    v_valid_until date;
    v_conversation_id text;
    v_actor_user_id uuid;
BEGIN
    SELECT * INTO v_q
    FROM public.quotations
    WHERE id = p_quotation_id
      AND organization_id = p_org_id
    FOR UPDATE;

    IF v_q.id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'errorCode', 'NOT_FOUND',
            'message', 'Cotización no encontrada.'
        );
    END IF;

    -- Idempotencia: si ya fue emitida, devolver su folio actual sin duplicar.
    IF v_q.status IN ('emitida', 'enviada', 'aceptada', 'convertida') THEN
        RETURN jsonb_build_object(
            'ok', true,
            'alreadyEmitted', true,
            'quotationId', v_q.id,
            'folio', v_q.folio,
            'folioYear', v_q.folio_year,
            'folioNumber', v_q.folio_number,
            'revisionNumber', v_q.revision_number,
            'issuedAt', v_q.issued_at,
            'validUntil', v_q.valid_until,
            'priceChanges', '[]'::jsonb
        );
    END IF;

    IF v_q.status <> 'borrador' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'errorCode', 'INVALID_STATUS',
            'status', v_q.status,
            'message', format('La cotización no está en borrador (estado actual: %s).', v_q.status)
        );
    END IF;

    SELECT count(*) INTO v_items_count
    FROM public.quotation_items
    WHERE quotation_id = v_q.id;

    IF v_items_count = 0 THEN
        RETURN jsonb_build_object(
            'ok', false,
            'errorCode', 'EMPTY_CART',
            'message', 'El carrito está vacío; agregue al menos una partida antes de emitir.'
        );
    END IF;

    -- Re-verificar disponibilidad y precio de cada partida contra el catálogo vigente
    FOR v_item IN
        SELECT * FROM public.quotation_items
        WHERE quotation_id = v_q.id
        ORDER BY line_number ASC
        FOR UPDATE
    LOOP
        SELECT * INTO v_resolved
        FROM public.resolve_variant_for_org(p_org_id, v_item.sku);

        IF v_resolved.variant_id IS NULL OR NOT COALESCE(v_resolved.is_available, false) THEN
            RETURN jsonb_build_object(
                'ok', false,
                'errorCode', 'ITEM_UNAVAILABLE',
                'sku', v_item.sku,
                'productName', v_item.product_name,
                'message', format('La partida "%s" (%s) ya no está disponible en el catálogo.', v_item.product_name, v_item.sku)
            );
        END IF;

        IF v_resolved.is_inventoriable AND v_resolved.stock_status = 'agotado' THEN
            RETURN jsonb_build_object(
                'ok', false,
                'errorCode', 'ITEM_OUT_OF_STOCK',
                'sku', v_item.sku,
                'productName', v_item.product_name,
                'message', format('El producto "%s" (%s) se agotó antes de emitir la cotización.', v_item.product_name, v_item.sku)
            );
        END IF;

        IF v_resolved.price IS NULL THEN
            RETURN jsonb_build_object(
                'ok', false,
                'errorCode', 'ITEM_CUSTOM_PRICE',
                'sku', v_item.sku,
                'productName', v_item.product_name,
                'message', format('La partida "%s" pasó a cotización a medida.', v_item.product_name)
            );
        END IF;

        IF v_resolved.price IS DISTINCT FROM v_item.unit_price THEN
            v_price_changes := v_price_changes || jsonb_build_array(
                jsonb_build_object(
                    'sku', v_item.sku,
                    'productName', v_resolved.product_name,
                    'oldPrice', v_item.unit_price,
                    'newPrice', v_resolved.price
                )
            );
        END IF;

        -- Actualizar snapshot descriptivo y fiscal al momento de emitir
        UPDATE public.quotation_items
        SET product_name = v_resolved.product_name,
            presentation = v_resolved.presentation,
            description = v_resolved.description,
            external_id = v_resolved.external_id,
            sat_product_key = v_resolved.sat_product_key,
            sat_unit_key = v_resolved.sat_unit_key,
            item_type = v_resolved.item_type,
            billing_period = v_resolved.billing_period,
            unit_price = v_resolved.price,
            price_includes_tax = v_resolved.price_includes_tax,
            tax_rate = v_resolved.tax_rate,
            updated_at = now()
        WHERE id = v_item.id;
    END LOOP;

    -- Si p_totals incluye desglose por línea (lines), aplicarlo y validar invariantes baratos
    IF p_totals ? 'lines' AND jsonb_typeof(p_totals->'lines') = 'array' THEN
        UPDATE public.quotation_items qi
        SET line_subtotal = (l.val->>'lineSubtotal')::numeric(14,2),
            line_tax      = (l.val->>'lineTax')::numeric(14,2),
            line_total    = (l.val->>'lineTotal')::numeric(14,2),
            discount_amount = COALESCE((l.val->>'discountAmount')::numeric(14,2), qi.discount_amount)
        FROM jsonb_array_elements(p_totals->'lines') AS l(val)
        WHERE qi.quotation_id = v_q.id
          AND upper(qi.sku) = upper(l.val->>'sku');
    END IF;

    -- Validar invariantes aritméticos en SQL (total = Σ partidas y coherencia subtotal + tax = total)
    SELECT
        COALESCE(sum(line_subtotal), 0),
        COALESCE(sum(line_tax), 0),
        COALESCE(sum(discount_amount), 0),
        COALESCE(sum(line_total), 0)
    INTO v_sum_subtotal, v_sum_tax, v_sum_discount, v_sum_total
    FROM public.quotation_items
    WHERE quotation_id = v_q.id;

    v_in_subtotal := (p_totals->>'subtotal')::numeric(14,2);
    v_in_tax      := (p_totals->>'taxTotal')::numeric(14,2);
    v_in_discount := COALESCE((p_totals->>'discountTotal')::numeric(14,2), 0);
    v_in_total    := (p_totals->>'total')::numeric(14,2);

    IF v_in_subtotal IS NULL OR v_in_tax IS NULL OR v_in_total IS NULL THEN
        RAISE EXCEPTION 'Los totales calculados son obligatorios para emitir la cotización.'
            USING ERRCODE = '23514';
    END IF;

    IF v_in_subtotal + v_in_tax <> v_in_total
       OR v_in_subtotal <> v_sum_subtotal
       OR v_in_tax <> v_sum_tax
       OR v_in_total <> v_sum_total THEN
        RAISE EXCEPTION 'Invariante de totales de cotización inválido: cabecera (%, %, %) != suma de partidas (%, %, %).',
            v_in_subtotal, v_in_tax, v_in_total, v_sum_subtotal, v_sum_tax, v_sum_total
            USING ERRCODE = '23514';
    END IF;

    -- Configuración de la organización
    SELECT
        COALESCE(qs.folio_prefix, 'COT'),
        qs.terms_text,
        qs.notes_default,
        COALESCE(qs.validity_days, 15)
    INTO v_prefix, v_terms_default, v_notes_default, v_validity_days
    FROM public.quotation_settings qs
    WHERE qs.organization_id = p_org_id;

    v_prefix := COALESCE(v_prefix, 'COT');
    v_validity_days := COALESCE(v_validity_days, 15);

    SELECT COALESCE(o.timezone, 'America/Mexico_City') INTO v_tz
    FROM public.organizations o
    WHERE o.id = p_org_id;
    v_tz := COALESCE(v_tz, 'America/Mexico_City');

    v_valid_until := COALESCE(
        (p_totals->>'validUntil')::date,
        ((now() AT TIME ZONE v_tz)::date + v_validity_days)
    );

    -- Generación de folio (o sufijo -R{n} si es revisión de otra cotización)
    IF v_q.revision_of_id IS NOT NULL AND v_q.revision_number > 0 THEN
        SELECT folio, folio_year, folio_number INTO v_root_q
        FROM public.quotations
        WHERE id = v_q.revision_of_id
          AND organization_id = p_org_id;

        v_year := v_root_q.folio_year;
        v_folio_number := v_root_q.folio_number;
        v_folio := regexp_replace(v_root_q.folio, '-R[0-9]+$', '') || '-R' || v_q.revision_number::text;
    ELSE
        v_year := COALESCE(
            (p_totals->>'folioYear')::integer,
            EXTRACT(YEAR FROM (now() AT TIME ZONE v_tz))::integer
        );

        INSERT INTO public.quotation_folio_counters (organization_id, year, last_value, updated_at)
        VALUES (p_org_id, v_year, 1, now())
        ON CONFLICT (organization_id, year)
        DO UPDATE SET
            last_value = public.quotation_folio_counters.last_value + 1,
            updated_at = now()
        RETURNING last_value INTO v_folio_number;

        v_folio := v_prefix || '-' || v_year::text || '-' || lpad(v_folio_number::text, 6, '0');
    END IF;

    -- Si p_totals provee priceChanges detectados antes de entrar a la RPC, combinarlos
    IF p_totals ? 'priceChanges' AND jsonb_typeof(p_totals->'priceChanges') = 'array' AND jsonb_array_length(v_price_changes) = 0 THEN
        v_price_changes := p_totals->'priceChanges';
    END IF;

    UPDATE public.quotations
    SET status = 'emitida',
        folio = v_folio,
        folio_year = v_year,
        folio_number = v_folio_number,
        customer_name = COALESCE(NULLIF(btrim(p_customer->>'name'), ''), customer_name),
        customer_email = COALESCE(NULLIF(btrim(p_customer->>'email'), ''), customer_email),
        customer_phone_e164 = COALESCE(NULLIF(btrim(p_customer->>'phoneE164'), ''), customer_phone_e164),
        customer_business_name = COALESCE(NULLIF(btrim(p_customer->>'businessName'), ''), customer_business_name),
        subtotal = v_in_subtotal,
        tax_total = v_in_tax,
        discount_total = v_in_discount,
        total = v_in_total,
        totals_by_billing = COALESCE(p_totals->'totalsByBilling', '[]'::jsonb),
        tax_breakdown = COALESCE(p_totals->'taxBreakdown', '[]'::jsonb),
        notes = COALESCE(notes, v_notes_default),
        terms_text = COALESCE(terms_text, v_terms_default),
        issued_at = now(),
        valid_until = v_valid_until,
        last_conversation_id = COALESCE(NULLIF(p_customer->>'conversationId', ''), last_conversation_id),
        last_activity_at = now(),
        updated_at = now()
    WHERE id = v_q.id
    RETURNING * INTO v_q;

    v_conversation_id := COALESCE(NULLIF(p_customer->>'conversationId', ''), v_q.last_conversation_id);
    IF p_customer ? 'actorUserId' AND NULLIF(p_customer->>'actorUserId', '') IS NOT NULL THEN
        v_actor_user_id := (p_customer->>'actorUserId')::uuid;
    END IF;

    IF jsonb_array_length(v_price_changes) > 0 THEN
        INSERT INTO public.quotation_events (organization_id, quotation_id, event_type, actor_user_id, conversation_id, payload)
        VALUES (
            p_org_id,
            v_q.id,
            'precio_cambiado_al_emitir',
            v_actor_user_id,
            v_conversation_id,
            jsonb_build_object('priceChanges', v_price_changes)
        );
    END IF;

    INSERT INTO public.quotation_events (organization_id, quotation_id, event_type, actor_user_id, conversation_id, payload)
    VALUES (
        p_org_id,
        v_q.id,
        'emitida',
        v_actor_user_id,
        v_conversation_id,
        jsonb_build_object('folio', v_q.folio, 'total', v_q.total, 'currency', v_q.currency)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'alreadyEmitted', false,
        'quotationId', v_q.id,
        'folio', v_q.folio,
        'folioYear', v_q.folio_year,
        'folioNumber', v_q.folio_number,
        'revisionNumber', v_q.revision_number,
        'issuedAt', v_q.issued_at,
        'validUntil', v_q.valid_until,
        'priceChanges', v_price_changes
    );
END;
$$;

REVOKE ALL ON FUNCTION public.quotation_emit(uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quotation_emit(uuid, uuid, jsonb, jsonb) TO service_role;


CREATE OR REPLACE FUNCTION public.quotation_search_products(
    p_org_id uuid,
    p_query  text,
    p_limit  integer DEFAULT 10
)
RETURNS TABLE (
    variant_id         uuid,
    product_id         uuid,
    catalog_id         uuid,
    sku                text,
    product_name       text,
    presentation       text,
    description        text,
    item_type          text,
    is_inventoriable   boolean,
    billing_period     text,
    price              numeric,
    currency           text,
    price_includes_tax boolean,
    tax_rate           numeric,
    stock_status       text,
    stock_note         text,
    sat_product_key    text,
    sat_unit_key       text,
    maintenance_sku    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH q AS (
        SELECT btrim(COALESCE(p_query, '')) AS term
    )
    SELECT
        v.id AS variant_id,
        p.id AS product_id,
        v.catalog_id,
        v.sku,
        p.name AS product_name,
        v.presentation,
        p.description,
        p.item_type,
        p.is_inventoriable,
        v.billing_period,
        COALESCE(ov.price, v.price) AS price,
        v.currency,
        v.price_includes_tax,
        v.tax_rate,
        CASE
            WHEN p.is_inventoriable THEN COALESCE(ov.stock_status, v.stock_status)
            ELSE 'no_aplica'::text
        END AS stock_status,
        CASE
            WHEN p.is_inventoriable THEN COALESCE(ov.stock_note, v.stock_note)
            ELSE NULL::text
        END AS stock_note,
        p.sat_product_key,
        v.sat_unit_key,
        CASE
            WHEN p.item_type = 'plan' THEN (
                SELECT v2.sku
                FROM public.products p2
                JOIN public.product_variants v2 ON v2.product_id = p2.id AND v2.catalog_id = p2.catalog_id
                WHERE p2.catalog_id = p.catalog_id
                  AND p2.bundle_parent_id = p.id
                  AND p2.is_active = true
                  AND v2.is_active = true
                  AND v2.billing_period = 'mensual'
                LIMIT 1
            )
            ELSE NULL::text
        END AS maintenance_sku
    FROM public.product_variants v
    JOIN public.products p ON p.id = v.product_id AND p.catalog_id = v.catalog_id
    JOIN public.catalogs c ON c.id = v.catalog_id
    JOIN public.catalog_access ca
        ON ca.catalog_id = v.catalog_id AND ca.organization_id = p_org_id
    LEFT JOIN public.organization_variant_overrides ov
        ON ov.variant_id = v.id AND ov.organization_id = p_org_id
    CROSS JOIN q
    WHERE p.is_active = true
      AND v.is_active = true
      AND COALESCE(ov.is_available, true) = true
      AND (
          q.term = ''
          OR p.name ILIKE '%' || q.term || '%'
          OR COALESCE(p.keywords, '') ILIKE '%' || q.term || '%'
          OR COALESCE(p.brand, '') ILIKE '%' || q.term || '%'
          OR v.sku ILIKE '%' || q.term || '%'
          OR COALESCE(v.presentation, '') ILIKE '%' || q.term || '%'
          OR word_similarity(q.term, p.name) >= 0.25
          OR word_similarity(q.term, COALESCE(p.keywords, '')) >= 0.25
          OR similarity(q.term, v.sku) >= 0.25
      )
    ORDER BY
        (upper(v.sku) = upper(q.term)) DESC,
        (c.owner_organization_id = p_org_id) DESC,
        GREATEST(
            word_similarity(q.term, p.name),
            word_similarity(q.term, COALESCE(p.keywords, '')),
            similarity(q.term, v.sku),
            word_similarity(q.term, COALESCE(v.presentation, ''))
        ) DESC,
        p.name ASC,
        v.sku ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
$$;

REVOKE ALL ON FUNCTION public.quotation_search_products(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quotation_search_products(uuid, text, integer) TO service_role;


CREATE OR REPLACE FUNCTION public.purge_abandoned_quotations()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_purged integer := 0;
BEGIN
    PERFORM set_config('datagol.purge_abandoned', 'on', true);

    DELETE FROM public.quotations q
    USING public.organizations o
    WHERE q.organization_id = o.id
      AND q.status = 'abandonada'
      AND q.last_activity_at < now() - (COALESCE(o.retention_days, 90) || ' days')::interval;

    GET DIAGNOSTICS v_purged = ROW_COUNT;

    PERFORM set_config('datagol.purge_abandoned', '', true);

    RETURN jsonb_build_object(
        'abandoned_quotations_purged', v_purged,
        'ran_at', now()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_abandoned_quotations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_abandoned_quotations() TO service_role;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'purge-abandoned-quotations';

SELECT cron.schedule(
    'purge-abandoned-quotations',
    '15 3 * * *',
    $$SELECT public.purge_abandoned_quotations();$$
);


-- =============================================================================
-- BLOQUE 6 — Actualización de factory_reset_transactional_data, erase_contact_pii y bucket
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

    UPDATE public.contacts
    SET full_name = NULL,
        email = NULL,
        business_name = NULL,
        business_sector = NULL,
        opted_out = true,
        opted_out_at = COALESCE(opted_out_at, now()),
        updated_at = now()
    WHERE id = p_contact_id;

    UPDATE public.leads
    SET full_name = NULL,
        email = NULL,
        contact_phone = NULL,
        business_name = NULL,
        updated_at = now()
    WHERE contact_id = p_contact_id;

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

    UPDATE public.appointments
    SET customer_name = 'Cliente eliminado (ARCO)',
        customer_email = NULL,
        customer_phone = '+000000000000',
        service_address = NULL,
        latitude = NULL,
        longitude = NULL
    WHERE contact_id = p_contact_id;

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

CREATE OR REPLACE FUNCTION public.factory_reset_transactional_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_counts jsonb := '{}'::jsonb;
    v_rows integer;
BEGIN
    SET LOCAL session_replication_role = replica;

    UPDATE public.usage_events SET call_log_id = NULL WHERE call_log_id IS NOT NULL;

    -- Cotizaciones transaccionales y reinicio de folios (conserva quotation_settings).
    DELETE FROM public.quotation_deliveries WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('quotation_deliveries_deleted', v_rows);

    DELETE FROM public.quotation_events WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('quotation_events_deleted', v_rows);

    DELETE FROM public.quotation_items WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('quotation_items_deleted', v_rows);

    DELETE FROM public.quotations WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('quotations_deleted', v_rows);

    DELETE FROM public.quotation_folio_counters WHERE organization_id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('quotation_folio_counters_deleted', v_rows);

    -- Hijas de contacts/leads/call_logs/appointments.
    DELETE FROM public.thank_you_sends WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('thank_you_sends_deleted', v_rows);

    DELETE FROM public.whatsapp_messages WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('whatsapp_messages_deleted', v_rows);

    DELETE FROM public.email_outbox WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('email_outbox_deleted', v_rows);

    DELETE FROM public.contact_pipeline_transitions WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('contact_pipeline_transitions_deleted', v_rows);

    DELETE FROM public.appointment_waitlist WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('appointment_waitlist_deleted', v_rows);

    -- Historial conversacional de Telegram (conserva telegram_connections y telegram_identities).
    DELETE FROM public.telegram_messages WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('telegram_messages_deleted', v_rows);

    DELETE FROM public.telegram_conversations WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('telegram_conversations_deleted', v_rows);

    DELETE FROM public.telegram_link_tokens
    WHERE used_at IS NOT NULL OR expires_at <= now();
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('telegram_link_tokens_deleted', v_rows);

    -- Núcleo transaccional.
    DELETE FROM public.appointments WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('appointments_deleted', v_rows);

    DELETE FROM public.leads WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('leads_deleted', v_rows);

    DELETE FROM public.call_logs WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('call_logs_deleted', v_rows);

    DELETE FROM public.contact_notes WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('contact_notes_deleted', v_rows);

    DELETE FROM public.contact_addresses WHERE contact_id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('contact_addresses_deleted', v_rows);

    DELETE FROM public.contacts WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('contacts_deleted', v_rows);

    -- Bitácoras de auditoría.
    DELETE FROM public.feature_audit_log WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('feature_audit_log_deleted', v_rows);

    DELETE FROM public.permission_audit_log WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('permission_audit_log_deleted', v_rows);

    -- Historial de pruebas sin valor de configuración.
    DELETE FROM public.unanswered_questions WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('unanswered_questions_deleted', v_rows);

    DELETE FROM public.weekly_reports WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('weekly_reports_deleted', v_rows);

    DELETE FROM public.competitor_site_snapshots WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('competitor_site_snapshots_deleted', v_rows);

    DELETE FROM public.outbound_call_attempts WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('outbound_call_attempts_deleted', v_rows);

    DELETE FROM public.organization_usage_alerts WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('organization_usage_alerts_deleted', v_rows);

    DELETE FROM public.concurrency_quota_alerts WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('concurrency_quota_alerts_deleted', v_rows);

    DELETE FROM public.catalog_imports WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('catalog_imports_deleted', v_rows);

    DELETE FROM public.organization_invitations
    WHERE accepted_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= now();
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('organization_invitations_deleted', v_rows);

    SET LOCAL session_replication_role = DEFAULT;

    RETURN v_counts;
END;
$$;

-- Bucket privado para PDFs de cotizaciones
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('quotations', 'quotations', false, 10485760, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;
