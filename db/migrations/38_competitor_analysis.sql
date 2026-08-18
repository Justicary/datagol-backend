-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 38_competitor_analysis.sql
-- =============================================================================
-- Análisis de competencia (docs/tasks/reportes-semanales.md, Fase C):
-- hasta 3 sitios públicos por organización, revisados una vez por semana,
-- comparados contra la semana anterior, e incluidos como sección aparte
-- (etiquetada como aproximada) del reporte ejecutivo semanal (Fase B).
--
-- 1. competitor_sites: configuración del tenant (qué URLs vigilar). RLS de
--    lectura/escritura para el propio tenant, mismo patrón que
--    widget_origins (migración 32) — es configuración de negocio que el
--    dashboard lee y escribe, no un log interno. El límite de 3 sitios por
--    organización (C.1) NO se expresa aquí como constraint: no hay
--    precedente de un tope de conteo a nivel de base en este repo (tampoco
--    lo tiene widget_origins) — se aplica en
--    routes/organization-competitor-sites.ts.
--
-- 2. competitor_site_snapshots: una fila por sitio por semana ISO
--    (UNIQUE competitor_site_id/week_start) — la misma idempotencia "un
--    acceso por sitio por semana" de C.2, mismo patrón INSERT ... ON
--    CONFLICT DO NOTHING que weekly_reports (migración 36). Guarda
--    ÚNICAMENTE texto extraído (extracted_text), nunca HTML — cumpliendo
--    C.2 literalmente. RLS de solo lectura para el tenant: la escritura es
--    siempre service_role desde src/jobs/check-competitor-site.ts.
--
-- 3. features/plan_features: siembra 'competitor_analysis' (categoría
--    'operacion', requires_provider NULL — reutiliza la llave BYOK de LLM
--    de la Fase A) asignada SOLO a elite/enterprise (a diferencia de
--    weekly_planning_report/weekly_executive_report, que sí incluyen pro) —
--    "tiene costo de tokens y riesgo distinto" (C.5). La guarda adicional de
--    llm_api_key validada vive en código (entitlements.ts), mismo mecanismo
--    ya usado para las dos features de la Fase B.
-- =============================================================================

-- =============================================================================
-- BLOQUE 1 — competitor_sites
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.competitor_sites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    url text NOT NULL,
    label text,
    enabled boolean NOT NULL DEFAULT true,
    last_checked_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_competitor_sites_organization_id
    ON public.competitor_sites (organization_id);

ALTER TABLE public.competitor_sites ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.competitor_sites
    FOR ALL
    USING (organization_id IN (SELECT auth_active_organization_ids()))
    WITH CHECK (organization_id IN (SELECT auth_active_organization_ids()));

COMMENT ON TABLE public.competitor_sites IS
    'Sitios de la competencia vigilados semanalmente por organización (máx. 3, aplicado en routes/organization-competitor-sites.ts). Fase C de docs/tasks/reportes-semanales.md.';

-- =============================================================================
-- BLOQUE 2 — competitor_site_snapshots
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.competitor_site_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    competitor_site_id uuid NOT NULL REFERENCES public.competitor_sites(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    week_start date NOT NULL,
    fetch_status text NOT NULL CHECK (fetch_status IN ('ok', 'blocked_by_robots', 'http_error', 'timeout', 'network_error')),
    extracted_text text,
    error text,
    checked_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (competitor_site_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_competitor_site_snapshots_org_week
    ON public.competitor_site_snapshots (organization_id, week_start DESC);

ALTER TABLE public.competitor_site_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON public.competitor_site_snapshots
    FOR SELECT
    USING (organization_id IN (SELECT auth_active_organization_ids()));

COMMENT ON TABLE public.competitor_site_snapshots IS
    'Instantánea semanal de texto extraído por sitio (nunca HTML crudo). UNIQUE (competitor_site_id, week_start) es la idempotencia "un acceso por sitio por semana" de C.2. Solo service_role escribe.';

-- =============================================================================
-- BLOQUE 3 — Semilla de features
-- =============================================================================

INSERT INTO public.features (key, name, description, category, requires_provider, has_cost_impact, globally_disabled, sort_order)
VALUES (
    'competitor_analysis',
    'Análisis de competencia',
    'Compara semanalmente hasta 3 sitios de la competencia contra la semana anterior y agrega una sección aproximada al reporte ejecutivo. Requiere llave BYOK de LLM validada.',
    'operacion',
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

INSERT INTO public.plan_features (plan_key, feature_key, enabled)
VALUES
    ('elite', 'competitor_analysis', true),
    ('enterprise', 'competitor_analysis', true)
ON CONFLICT (plan_key, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled;
