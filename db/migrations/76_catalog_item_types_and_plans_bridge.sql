-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 76_catalog_item_types_and_plans_bridge.sql
-- =============================================================================
-- Fases B y B2 (docs/tasks/procedimiento-cotizaciones.md):
--   BLOQUE 1: Tipo de partida (`item_type`, `is_inventoriable`, `bundle_parent_id`)
--             en `products`, y modalidad de cobro (`billing_period`), clave de
--             unidad SAT (`sat_unit_key`) y `'no_aplica'` en `stock_status` de
--             `product_variants` y `organization_variant_overrides`.
--   BLOQUE 2: Trigger `enforce_variant_item_type` en `product_variants` y
--             `products` para garantizar coherencia entre inventariabilidad y
--             `stock_status`.
--   BLOQUE 3: Catálogos administrados (`catalogs.managed_source`) y trigger
--             `guard_managed_catalog_rows` en `products` y `product_variants`.
--   BLOQUE 4: Columna `annual_retainer_discount_pct` en `plans`, ajuste de
--             `record_price_change()` para `datagol.price_source`, función
--             `sync_plan_to_catalog(p_plan_key)` y trigger `trg_plans_sync_catalog`.
--   BLOQUE 5: Actualización determinista de `resolve_variant_for_org(p_org_id, p_sku)`
--             (H3 + campos de B2).
--   BLOQUE 6: Función `organization_has_catalog_feature(p_org_id)` y endurecimiento
--             de políticas RLS de escritura del catálogo (H19).
-- =============================================================================

-- =============================================================================
-- BLOQUE 1 — Tipo de partida, modalidad de cobro y clave de unidad SAT
-- =============================================================================

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'producto';

ALTER TABLE public.products
    DROP CONSTRAINT IF EXISTS products_item_type_check;

ALTER TABLE public.products
    ADD CONSTRAINT products_item_type_check
    CHECK (item_type IN ('producto', 'servicio', 'plan'));

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS is_inventoriable boolean
    GENERATED ALWAYS AS (item_type = 'producto') STORED;

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS bundle_parent_id uuid NULL;

ALTER TABLE public.products
    DROP CONSTRAINT IF EXISTS products_bundle_parent_fk;

ALTER TABLE public.products
    ADD CONSTRAINT products_bundle_parent_fk
    FOREIGN KEY (bundle_parent_id, catalog_id)
    REFERENCES public.products (id, catalog_id)
    ON DELETE SET NULL (bundle_parent_id);

CREATE INDEX IF NOT EXISTS idx_products_bundle_parent
    ON public.products (catalog_id, bundle_parent_id)
    WHERE bundle_parent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_products_catalog_external_id
    ON public.products (catalog_id, external_id)
    WHERE external_id IS NOT NULL;

ALTER TABLE public.product_variants
    ADD COLUMN IF NOT EXISTS billing_period text NOT NULL DEFAULT 'unico';

ALTER TABLE public.product_variants
    DROP CONSTRAINT IF EXISTS product_variants_billing_period_check;

ALTER TABLE public.product_variants
    ADD CONSTRAINT product_variants_billing_period_check
    CHECK (billing_period IN ('unico', 'mensual', 'anual'));

ALTER TABLE public.product_variants
    ADD COLUMN IF NOT EXISTS sat_unit_key text NULL;

ALTER TABLE public.product_variants
    DROP CONSTRAINT IF EXISTS product_variants_stock_status_check;

ALTER TABLE public.product_variants
    ADD CONSTRAINT product_variants_stock_status_check
    CHECK (stock_status IN ('disponible', 'bajo', 'agotado', 'bajo_pedido', 'sin_dato', 'no_aplica'));

ALTER TABLE public.organization_variant_overrides
    DROP CONSTRAINT IF EXISTS organization_variant_overrides_stock_status_check;

ALTER TABLE public.organization_variant_overrides
    ADD CONSTRAINT organization_variant_overrides_stock_status_check
    CHECK (stock_status IS NULL OR stock_status IN ('disponible', 'bajo', 'agotado', 'bajo_pedido', 'sin_dato', 'no_aplica'));


-- =============================================================================
-- BLOQUE 2 — Trigger enforce_variant_item_type
-- =============================================================================
-- Reglas:
--   - Producto no inventariable ('servicio', 'plan'): fuerza stock_status = 'no_aplica'
--     y stock_note = NULL. Si en un INSERT o UPDATE se envía explícitamente otro
--     stock_status distinto de 'no_aplica' y distinto del default 'sin_dato' en INSERT,
--     o en UPDATE se intenta cambiar a otro valor distinto de 'no_aplica', se rechaza
--     con 23514 para cumplir B2.6 ("Servicio no puede tener stock_status distinto de
--     no_aplica; producto no puede tener no_aplica (rechazo + éxito)"), mientras que un
--     INSERT que omite stock_status (recibiendo el default 'sin_dato') se normaliza
--     automáticamente a 'no_aplica'.
--   - Producto inventariable ('producto'): rechaza stock_status = 'no_aplica' con 23514.
--   - Al cambiar products.item_type: reajusta automáticamente todas sus variantes.

CREATE OR REPLACE FUNCTION public.enforce_variant_item_type()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_item_type text;
BEGIN
    SELECT p.item_type INTO v_item_type
    FROM public.products p
    WHERE p.id = NEW.product_id
      AND p.catalog_id = NEW.catalog_id;

    IF v_item_type IS NULL THEN
        RETURN NEW;
    END IF;

    IF v_item_type IN ('servicio', 'plan') THEN
        IF TG_OP = 'INSERT' THEN
            IF NEW.stock_status IS NOT NULL
               AND NEW.stock_status NOT IN ('no_aplica', 'sin_dato') THEN
                RAISE EXCEPTION 'Una partida de tipo % no es inventariable y no puede tener stock_status = %.', v_item_type, NEW.stock_status
                    USING ERRCODE = '23514';
            END IF;
        ELSIF TG_OP = 'UPDATE' THEN
            IF NEW.stock_status IS DISTINCT FROM 'no_aplica'
               AND current_setting('datagol.item_type_Cascade', true) IS DISTINCT FROM 'on' THEN
                RAISE EXCEPTION 'Una partida de tipo % no es inventariable y no puede tener stock_status = %.', v_item_type, NEW.stock_status
                    USING ERRCODE = '23514';
            END IF;
        END IF;

        NEW.stock_status := 'no_aplica';
        NEW.stock_note := NULL;
    ELSE
        -- v_item_type = 'producto' (inventariable)
        IF NEW.stock_status = 'no_aplica' THEN
            RAISE EXCEPTION 'Un producto inventariable no puede tener stock_status = no_aplica.'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_variant_item_type ON public.product_variants;
CREATE TRIGGER trg_enforce_variant_item_type
    BEFORE INSERT OR UPDATE ON public.product_variants
    FOR EACH ROW EXECUTE FUNCTION public.enforce_variant_item_type();

CREATE OR REPLACE FUNCTION public.sync_variants_on_product_item_type_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.item_type IS NOT DISTINCT FROM OLD.item_type THEN
        RETURN NEW;
    END IF;

    PERFORM set_config('datagol.item_type_Cascade', 'on', true);

    IF NEW.item_type IN ('servicio', 'plan') THEN
        UPDATE public.product_variants
        SET stock_status = 'no_aplica',
            stock_note = NULL,
            updated_at = now()
        WHERE product_id = NEW.id
          AND catalog_id = NEW.catalog_id
          AND (stock_status IS DISTINCT FROM 'no_aplica' OR stock_note IS NOT NULL);
    ELSE
        UPDATE public.product_variants
        SET stock_status = 'sin_dato',
            updated_at = now()
        WHERE product_id = NEW.id
          AND catalog_id = NEW.catalog_id
          AND stock_status = 'no_aplica';
    END IF;

    PERFORM set_config('datagol.item_type_Cascade', '', true);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_item_type_variants ON public.products;
CREATE TRIGGER trg_products_item_type_variants
    AFTER UPDATE OF item_type ON public.products
    FOR EACH ROW EXECUTE FUNCTION public.sync_variants_on_product_item_type_change();


-- =============================================================================
-- BLOQUE 3 — Catálogos administrados (managed_source) y guard_managed_catalog_rows
-- =============================================================================

ALTER TABLE public.catalogs
    ADD COLUMN IF NOT EXISTS managed_source text NULL;

ALTER TABLE public.catalogs
    DROP CONSTRAINT IF EXISTS catalogs_managed_source_check;

ALTER TABLE public.catalogs
    ADD CONSTRAINT catalogs_managed_source_check
    CHECK (managed_source IS NULL OR managed_source IN ('datagol_plans'));

CREATE UNIQUE INDEX IF NOT EXISTS ux_catalogs_managed_source
    ON public.catalogs (managed_source)
    WHERE managed_source IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_managed_catalog_rows()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_catalog_id uuid;
    v_managed_source text;
BEGIN
    IF current_setting('datagol.managed_sync', true) = 'on' THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    v_catalog_id := COALESCE(NEW.catalog_id, OLD.catalog_id);

    SELECT c.managed_source INTO v_managed_source
    FROM public.catalogs c
    WHERE c.id = v_catalog_id;

    -- Si el catálogo no existe (p. ej. borrado en cascada del catálogo mismo) o no es administrado, permitir.
    IF v_managed_source IS NULL THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP IN ('INSERT', 'DELETE') THEN
        RAISE EXCEPTION 'Este campo se administra desde Planes (/admin/plans)'
            USING ERRCODE = '42501';
    END IF;

    IF TG_TABLE_NAME = 'products' THEN
        IF NEW.name IS DISTINCT FROM OLD.name
           OR NEW.item_type IS DISTINCT FROM OLD.item_type
           OR NEW.bundle_parent_id IS DISTINCT FROM OLD.bundle_parent_id
           OR NEW.external_id IS DISTINCT FROM OLD.external_id
           OR NEW.is_active IS DISTINCT FROM OLD.is_active
           OR NEW.catalog_id IS DISTINCT FROM OLD.catalog_id THEN
            RAISE EXCEPTION 'Este campo se administra desde Planes (/admin/plans)'
                USING ERRCODE = '42501';
        END IF;
    ELSIF TG_TABLE_NAME = 'product_variants' THEN
        IF NEW.sku IS DISTINCT FROM OLD.sku
           OR NEW.price IS DISTINCT FROM OLD.price
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.price_includes_tax IS DISTINCT FROM OLD.price_includes_tax
           OR NEW.tax_rate IS DISTINCT FROM OLD.tax_rate
           OR NEW.billing_period IS DISTINCT FROM OLD.billing_period
           OR NEW.is_active IS DISTINCT FROM OLD.is_active
           OR NEW.product_id IS DISTINCT FROM OLD.product_id
           OR NEW.catalog_id IS DISTINCT FROM OLD.catalog_id THEN
            RAISE EXCEPTION 'Este campo se administra desde Planes (/admin/plans)'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_managed_products ON public.products;
CREATE TRIGGER trg_guard_managed_products
    BEFORE INSERT OR UPDATE OR DELETE ON public.products
    FOR EACH ROW EXECUTE FUNCTION public.guard_managed_catalog_rows();

DROP TRIGGER IF EXISTS trg_guard_managed_variants ON public.product_variants;
CREATE TRIGGER trg_guard_managed_variants
    BEFORE INSERT OR UPDATE OR DELETE ON public.product_variants
    FOR EACH ROW EXECUTE FUNCTION public.guard_managed_catalog_rows();


-- =============================================================================
-- BLOQUE 4 — Proyección de `plans` → catálogo administrado
-- =============================================================================

ALTER TABLE public.plans
    ADD COLUMN IF NOT EXISTS annual_retainer_discount_pct numeric(5,4) NOT NULL DEFAULT 0.2000;

ALTER TABLE public.plans
    DROP CONSTRAINT IF EXISTS plans_annual_retainer_discount_pct_check;

ALTER TABLE public.plans
    ADD CONSTRAINT plans_annual_retainer_discount_pct_check
    CHECK (annual_retainer_discount_pct >= 0 AND annual_retainer_discount_pct <= 0.9);

CREATE OR REPLACE FUNCTION public.record_price_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_source text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.price IS NOT DISTINCT FROM OLD.price THEN
            RETURN NEW;
        END IF;

        NEW.price_changed_at := now();
        v_source := COALESCE(NULLIF(current_setting('datagol.price_source', true), ''), TG_OP);

        INSERT INTO public.variant_price_history (variant_id, price, currency, source)
        VALUES (NEW.id, NEW.price, NEW.currency, v_source);

        RETURN NEW;
    END IF;

    -- En INSERT (BEFORE trigger), la fila aún no existe físicamente; record_initial_price_history (AFTER INSERT) inserta el historial.
    NEW.price_changed_at := now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_initial_price_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_source text;
BEGIN
    v_source := COALESCE(NULLIF(current_setting('datagol.price_source', true), ''), 'INSERT');
    INSERT INTO public.variant_price_history (variant_id, price, currency, source)
    VALUES (NEW.id, NEW.price, NEW.currency, v_source);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_plan_to_catalog(p_plan_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_catalog_id uuid;
    v_plan record;
    v_plan_product_id uuid;
    v_retainer_product_id uuid;
    v_setup_desc text;
    v_retainer_desc text;
    v_retainer_active boolean;
    v_annual_price numeric(12,2);
    v_upper_key text;
BEGIN
    SELECT c.id INTO v_catalog_id
    FROM public.catalogs c
    WHERE c.managed_source = 'datagol_plans'
    LIMIT 1;

    IF v_catalog_id IS NULL THEN
        RETURN;
    END IF;

    v_upper_key := upper(p_plan_key);

    PERFORM set_config('datagol.managed_sync', 'on', true);
    PERFORM set_config('datagol.price_source', 'plans_sync', true);

    SELECT * INTO v_plan
    FROM public.plans
    WHERE key = p_plan_key;

    IF NOT FOUND THEN
        -- Plan eliminado: desactivar productos y variantes proyectados (nunca borrar).
        UPDATE public.products
        SET is_active = false,
            updated_at = now()
        WHERE catalog_id = v_catalog_id
          AND external_id IN ('plan:' || p_plan_key, 'plan-retainer:' || p_plan_key);

        UPDATE public.product_variants
        SET is_active = false,
            updated_at = now()
        WHERE catalog_id = v_catalog_id
          AND upper(sku) IN (
              'PLAN-' || v_upper_key,
              'MANT-' || v_upper_key || '-MENSUAL',
              'MANT-' || v_upper_key || '-ANUAL'
          );

        PERFORM set_config('datagol.managed_sync', '', true);
        PERFORM set_config('datagol.price_source', '', true);
        RETURN;
    END IF;

    v_setup_desc := concat_ws(
        E'\n',
        NULLIF(btrim(v_plan.target_audience), ''),
        NULLIF(array_to_string(v_plan.setup_includes, '; '), '')
    );

    v_retainer_desc := NULLIF(array_to_string(v_plan.retainer_includes, '; '), '');
    v_retainer_active := COALESCE(v_plan.is_active, true) AND COALESCE(v_plan.show_retainer, true);

    IF v_plan.monthly_fee_mxn IS NULL THEN
        v_annual_price := NULL;
    ELSE
        v_annual_price := round(v_plan.monthly_fee_mxn * (1 - COALESCE(v_plan.annual_retainer_discount_pct, 0.2000))) * 12;
    END IF;

    -- 1. Producto del plan (setup / pago único)
    INSERT INTO public.products (
        catalog_id,
        name,
        category,
        description,
        item_type,
        bundle_parent_id,
        is_active,
        external_id
    )
    VALUES (
        v_catalog_id,
        v_plan.name,
        'plan',
        v_setup_desc,
        'plan',
        NULL,
        COALESCE(v_plan.is_active, true),
        'plan:' || v_plan.key
    )
    ON CONFLICT (catalog_id, external_id) WHERE external_id IS NOT NULL
    DO UPDATE SET
        name = EXCLUDED.name,
        item_type = 'plan',
        bundle_parent_id = NULL,
        is_active = EXCLUDED.is_active,
        description = COALESCE(public.products.description, EXCLUDED.description),
        updated_at = now()
    RETURNING id INTO v_plan_product_id;

    -- Variante PLAN-{KEY} (pago único)
    INSERT INTO public.product_variants (
        product_id,
        catalog_id,
        sku,
        presentation,
        price,
        currency,
        price_includes_tax,
        tax_rate,
        billing_period,
        stock_status,
        is_active
    )
    VALUES (
        v_plan_product_id,
        v_catalog_id,
        'PLAN-' || v_upper_key,
        'Instalación y puesta en marcha (pago único)',
        v_plan.setup_fee_mxn,
        'MXN',
        false,
        0.1600,
        'unico',
        'no_aplica',
        COALESCE(v_plan.is_active, true)
    )
    ON CONFLICT (catalog_id, sku)
    DO UPDATE SET
        product_id = EXCLUDED.product_id,
        price = EXCLUDED.price,
        currency = 'MXN',
        price_includes_tax = false,
        tax_rate = 0.1600,
        billing_period = 'unico',
        is_active = EXCLUDED.is_active,
        updated_at = now();

    -- 2. Producto de mantenimiento (iguala opcional del plan)
    INSERT INTO public.products (
        catalog_id,
        name,
        category,
        description,
        item_type,
        bundle_parent_id,
        is_active,
        external_id
    )
    VALUES (
        v_catalog_id,
        'Mantenimiento ' || v_plan.name,
        'mantenimiento',
        v_retainer_desc,
        'servicio',
        v_plan_product_id,
        v_retainer_active,
        'plan-retainer:' || v_plan.key
    )
    ON CONFLICT (catalog_id, external_id) WHERE external_id IS NOT NULL
    DO UPDATE SET
        name = EXCLUDED.name,
        item_type = 'servicio',
        bundle_parent_id = EXCLUDED.bundle_parent_id,
        is_active = EXCLUDED.is_active,
        description = COALESCE(public.products.description, EXCLUDED.description),
        updated_at = now()
    RETURNING id INTO v_retainer_product_id;

    -- Variante MANT-{KEY}-MENSUAL
    INSERT INTO public.product_variants (
        product_id,
        catalog_id,
        sku,
        presentation,
        price,
        currency,
        price_includes_tax,
        tax_rate,
        billing_period,
        stock_status,
        is_active
    )
    VALUES (
        v_retainer_product_id,
        v_catalog_id,
        'MANT-' || v_upper_key || '-MENSUAL',
        'Iguala de mantenimiento mensual',
        v_plan.monthly_fee_mxn,
        'MXN',
        false,
        0.1600,
        'mensual',
        'no_aplica',
        v_retainer_active
    )
    ON CONFLICT (catalog_id, sku)
    DO UPDATE SET
        product_id = EXCLUDED.product_id,
        price = EXCLUDED.price,
        currency = 'MXN',
        price_includes_tax = false,
        tax_rate = 0.1600,
        billing_period = 'mensual',
        is_active = EXCLUDED.is_active,
        updated_at = now();

    -- Variante MANT-{KEY}-ANUAL
    INSERT INTO public.product_variants (
        product_id,
        catalog_id,
        sku,
        presentation,
        price,
        currency,
        price_includes_tax,
        tax_rate,
        billing_period,
        stock_status,
        is_active
    )
    VALUES (
        v_retainer_product_id,
        v_catalog_id,
        'MANT-' || v_upper_key || '-ANUAL',
        'Iguala de mantenimiento anual',
        v_annual_price,
        'MXN',
        false,
        0.1600,
        'anual',
        'no_aplica',
        v_retainer_active
    )
    ON CONFLICT (catalog_id, sku)
    DO UPDATE SET
        product_id = EXCLUDED.product_id,
        price = EXCLUDED.price,
        currency = 'MXN',
        price_includes_tax = false,
        tax_rate = 0.1600,
        billing_period = 'anual',
        is_active = EXCLUDED.is_active,
        updated_at = now();

    PERFORM set_config('datagol.managed_sync', '', true);
    PERFORM set_config('datagol.price_source', '', true);
END;
$$;

REVOKE ALL ON FUNCTION public.sync_plan_to_catalog(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_plan_to_catalog(text) TO service_role;

CREATE OR REPLACE FUNCTION public.trg_sync_plan_to_catalog_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM public.sync_plan_to_catalog(OLD.key);
        RETURN OLD;
    ELSE
        PERFORM public.sync_plan_to_catalog(NEW.key);
        RETURN NEW;
    END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_plans_sync_catalog ON public.plans;
CREATE TRIGGER trg_plans_sync_catalog
    AFTER INSERT OR UPDATE OR DELETE ON public.plans
    FOR EACH ROW EXECUTE FUNCTION public.trg_sync_plan_to_catalog_fn();


-- =============================================================================
-- BLOQUE 5 — Resolución determinista de variante (resolve_variant_for_org)
-- =============================================================================
-- H3 + B2: ORDER BY (c.owner_organization_id = p_org_id) DESC, v.catalog_id,
-- ignora override de stock_status en no inventariables, y expone variant_id,
-- product_id, catalog_id, item_type, is_inventoriable, billing_period, tax_rate,
-- external_id, sat_product_key, sat_unit_key y description.

DROP FUNCTION IF EXISTS public.resolve_variant_for_org(uuid, text);

CREATE OR REPLACE FUNCTION public.resolve_variant_for_org(p_org_id uuid, p_sku text)
RETURNS TABLE (
    sku                text,
    product_name       text,
    presentation       text,
    price              numeric,
    currency           text,
    price_includes_tax boolean,
    stock_status       text,
    stock_note         text,
    is_available       boolean,
    image_path         text,
    variant_id         uuid,
    product_id         uuid,
    catalog_id         uuid,
    item_type          text,
    is_inventoriable   boolean,
    billing_period     text,
    tax_rate           numeric,
    external_id        text,
    sat_product_key    text,
    sat_unit_key       text,
    description        text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        v.sku,
        p.name,
        v.presentation,
         COALESCE(ov.price, v.price),
        v.currency,
        v.price_includes_tax,
        CASE
            WHEN p.is_inventoriable THEN COALESCE(ov.stock_status, v.stock_status)
            ELSE 'no_aplica'::text
        END,
        CASE
            WHEN p.is_inventoriable THEN COALESCE(ov.stock_note, v.stock_note)
            ELSE NULL::text
        END,
        COALESCE(ov.is_available, true) AND v.is_active AND p.is_active,
        p.image_path,
        v.id,
        p.id,
        v.catalog_id,
        p.item_type,
        p.is_inventoriable,
        v.billing_period,
        v.tax_rate,
        p.external_id,
        p.sat_product_key,
        v.sat_unit_key,
        p.description
    FROM public.product_variants v
    JOIN public.products p ON p.id = v.product_id AND p.catalog_id = v.catalog_id
    JOIN public.catalogs c ON c.id = v.catalog_id
    JOIN public.catalog_access ca
        ON ca.catalog_id = v.catalog_id AND ca.organization_id = p_org_id
    LEFT JOIN public.organization_variant_overrides ov
        ON ov.variant_id = v.id AND ov.organization_id = p_org_id
    WHERE upper(v.sku) = upper(p_sku)
    ORDER BY (c.owner_organization_id = p_org_id) DESC, v.catalog_id ASC
    LIMIT 1;
$$;


-- =============================================================================
-- BLOQUE 6 — Guardas de feature de catálogo en RLS (H19)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.organization_has_catalog_feature(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_enabled_features(p_org_id) oef
        WHERE oef.feature_key IN ('product_rag', 'quotations')
    );
$$;

INSERT INTO public.plan_features (plan_key, feature_key, enabled) VALUES
    ('starter', 'product_rag', false),
    ('pro', 'product_rag', false),
    ('elite', 'product_rag', true),
    ('enterprise', 'product_rag', true)
ON CONFLICT (plan_key, feature_key) DO UPDATE SET
    enabled = EXCLUDED.enabled;

DROP POLICY IF EXISTS products_write ON public.products;
CREATE POLICY products_write ON public.products
    FOR ALL TO authenticated
    USING (
        catalog_id IN (
            SELECT ca.catalog_id
            FROM public.catalog_access ca
            WHERE ca.organization_id IN (SELECT public.auth_active_organization_ids())
              AND ca.can_edit
              AND public.has_permission(ca.organization_id, 'manage_catalog')
              AND public.organization_has_catalog_feature(ca.organization_id)
        )
    )
    WITH CHECK (
        catalog_id IN (
            SELECT ca.catalog_id
            FROM public.catalog_access ca
            WHERE ca.organization_id IN (SELECT public.auth_active_organization_ids())
              AND ca.can_edit
              AND public.has_permission(ca.organization_id, 'manage_catalog')
              AND public.organization_has_catalog_feature(ca.organization_id)
        )
    );

DROP POLICY IF EXISTS product_variants_write ON public.product_variants;
CREATE POLICY product_variants_write ON public.product_variants
    FOR ALL TO authenticated
    USING (
        catalog_id IN (
            SELECT ca.catalog_id
            FROM public.catalog_access ca
            WHERE ca.organization_id IN (SELECT public.auth_active_organization_ids())
              AND ca.can_edit
              AND public.has_permission(ca.organization_id, 'manage_catalog')
              AND public.organization_has_catalog_feature(ca.organization_id)
        )
    )
    WITH CHECK (
        catalog_id IN (
            SELECT ca.catalog_id
            FROM public.catalog_access ca
            WHERE ca.organization_id IN (SELECT public.auth_active_organization_ids())
              AND ca.can_edit
              AND public.has_permission(ca.organization_id, 'manage_catalog')
              AND public.organization_has_catalog_feature(ca.organization_id)
        )
    );

DROP POLICY IF EXISTS catalog_custom_fields_write ON public.catalog_custom_fields;
CREATE POLICY catalog_custom_fields_write ON public.catalog_custom_fields
    FOR ALL TO authenticated
    USING (
        catalog_id IN (
            SELECT ca.catalog_id
            FROM public.catalog_access ca
            WHERE ca.organization_id IN (SELECT public.auth_active_organization_ids())
              AND ca.can_edit
              AND public.has_permission(ca.organization_id, 'manage_catalog')
              AND public.organization_has_catalog_feature(ca.organization_id)
        )
    )
    WITH CHECK (
        catalog_id IN (
            SELECT ca.catalog_id
            FROM public.catalog_access ca
            WHERE ca.organization_id IN (SELECT public.auth_active_organization_ids())
              AND ca.can_edit
              AND public.has_permission(ca.organization_id, 'manage_catalog')
              AND public.organization_has_catalog_feature(ca.organization_id)
        )
    );

DROP POLICY IF EXISTS imports_write ON public.catalog_imports;
CREATE POLICY imports_write ON public.catalog_imports
    FOR ALL TO authenticated
    USING (
        catalog_id IN (
            SELECT ca.catalog_id
            FROM public.catalog_access ca
            WHERE ca.organization_id IN (SELECT public.auth_active_organization_ids())
              AND ca.can_edit
              AND public.has_permission(ca.organization_id, 'manage_catalog')
              AND public.organization_has_catalog_feature(ca.organization_id)
        )
    )
    WITH CHECK (
        catalog_id IN (
            SELECT ca.catalog_id
            FROM public.catalog_access ca
            WHERE ca.organization_id IN (SELECT public.auth_active_organization_ids())
              AND ca.can_edit
              AND public.has_permission(ca.organization_id, 'manage_catalog')
              AND public.organization_has_catalog_feature(ca.organization_id)
        )
    );
