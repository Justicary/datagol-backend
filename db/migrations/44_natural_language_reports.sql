-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 44_natural_language_reports.sql
-- =============================================================================
-- Reportes en Lenguaje Natural (docs/tasks/reportes-lenguaje-natural.md)
--
-- 1. Tabla unanswered_questions:
--    Bitácora de preguntas no resueltas, ambiguas (requiere_aclaracion) o con
--    error durante la clasificación/traducción del LLM. Es el activo principal
--    para guiar la priorización de intenciones de la v2 con datos reales.
--
-- 2. Feature natural_language_reports:
--    Inserta la feature en 'features' (categoría 'operacion', requires_provider NULL,
--    has_cost_impact false ya que la llave BYOK es del cliente).
--    Se habilita en 'plan_features' para los planes 'pro', 'elite' y 'enterprise'.
-- =============================================================================

-- =============================================================================
-- BLOQUE 1 — Tabla unanswered_questions y RLS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.unanswered_questions (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    question text NOT NULL,
    reason text NOT NULL CHECK (reason IN ('no_resuelta', 'requiere_aclaracion', 'error')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.unanswered_questions IS
    'Bitácora de preguntas que el módulo de reportes en lenguaje natural no pudo resolver, requirieron aclaración o produjeron error.';

COMMENT ON COLUMN public.unanswered_questions.reason IS
    'no_resuelta = fuera del catálogo v1; requiere_aclaracion = ambigua; error = fallo técnico en traducción o ejecución.';

-- Índices de consulta
CREATE INDEX IF NOT EXISTS idx_unanswered_questions_org_created
    ON public.unanswered_questions (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_unanswered_questions_reason_created
    ON public.unanswered_questions (reason, created_at DESC);

-- Habilitar RLS
ALTER TABLE public.unanswered_questions ENABLE ROW LEVEL SECURITY;

-- Política para miembros de la organización
DROP POLICY IF EXISTS unanswered_questions_org_access ON public.unanswered_questions;
CREATE POLICY unanswered_questions_org_access ON public.unanswered_questions
    FOR ALL
    TO authenticated
    USING (
        organization_id IN (
            SELECT om.organization_id
            FROM public.organization_members om
            WHERE om.user_id = auth.uid()
        )
    )
    WITH CHECK (
        organization_id IN (
            SELECT om.organization_id
            FROM public.organization_members om
            WHERE om.user_id = auth.uid()
        )
    );

-- Política para platform admin / service role
DROP POLICY IF EXISTS unanswered_questions_admin_all ON public.unanswered_questions;
CREATE POLICY unanswered_questions_admin_all ON public.unanswered_questions
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.organization_members
            WHERE user_id = auth.uid() AND role = 'platform_admin'
        )
    );

-- =============================================================================
-- BLOQUE 2 — Feature 'natural_language_reports' y Plan Features
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
) VALUES (
    'natural_language_reports',
    'Reportes en Lenguaje Natural',
    'Consultas y reportes ejecutivos interactivos en español traducidos mediante IA y ejecutados de forma determinista.',
    'operacion',
    NULL,
    false,
    false,
    65
) ON CONFLICT (key) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    category = EXCLUDED.category,
    sort_order = EXCLUDED.sort_order;

-- Asociar a los planes PRO, ELITE y ENTERPRISE
INSERT INTO public.plan_features (plan_key, feature_key, enabled)
VALUES
    ('pro', 'natural_language_reports', true),
    ('elite', 'natural_language_reports', true),
    ('enterprise', 'natural_language_reports', true)
ON CONFLICT (plan_key, feature_key) DO UPDATE SET
    enabled = EXCLUDED.enabled;

-- Starter explícitamente desactivado
INSERT INTO public.plan_features (plan_key, feature_key, enabled)
VALUES
    ('starter', 'natural_language_reports', false)
ON CONFLICT (plan_key, feature_key) DO UPDATE SET
    enabled = EXCLUDED.enabled;
