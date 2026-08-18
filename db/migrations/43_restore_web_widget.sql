-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 43_restore_web_widget.sql
-- =============================================================================
-- Restituye el feature 'web_widget' en el catálogo public.features y asegura
-- su asignación habilitada (enabled = true) para todos los planes en
-- public.plan_features (starter, pro, elite, enterprise).
--
-- La migración 42_remove_web_widget.sql eliminó la infraestructura de
-- sesiones y orígenes de backend (widget_origins, widget_session_attempts),
-- pero eliminó accidentalmente la feature 'web_widget' en el catálogo general
-- de entitlements. Este script reincorpora la fila en public.features
-- (categoría 'web', proveedor 'elevenlabs', has_cost_impact true) y siembra
-- su activación para todos los planes existentes en la tabla public.plans.
-- =============================================================================

INSERT INTO public.features (key, name, description, category, requires_provider, has_cost_impact, globally_disabled, sort_order)
VALUES (
    'web_widget',
    'Widget de chat web',
    'Permite incrustar el agente conversacional de ElevenLabs como widget de chat en el sitio web del cliente.',
    'web',
    'elevenlabs',
    true,
    false,
    (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM public.features)
)
ON CONFLICT (key) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    category = EXCLUDED.category,
    requires_provider = EXCLUDED.requires_provider,
    has_cost_impact = EXCLUDED.has_cost_impact,
    globally_disabled = EXCLUDED.globally_disabled;

INSERT INTO public.plan_features (plan_key, feature_key, enabled)
SELECT key, 'web_widget', true
FROM public.plans
ON CONFLICT (plan_key, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled;
