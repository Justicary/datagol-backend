-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 42_remove_web_widget.sql
-- =============================================================================
-- Elimina por completo la infraestructura del widget de chat web propio
-- (POST /api/widget/session, db/migrations/32_widget_origins.sql): ElevenLabs
-- ofrece su propio widget embebible que cumple el mismo propósito sin que
-- este backend intermedie la sesión. Verificado antes de escribir esta
-- migración que no hay uso real que perder: 0 filas en widget_origins,
-- 0 en widget_session_attempts, 0 organizaciones con la feature habilitada.
-- Las 27 filas de usage_events con unit_type='web_widget_session' son datos
-- de prueba (tabla append-only, AGENTS.md §6 — no se tocan, quedan como
-- historial inerte; el código ya no escribe ese unit_type).
--
-- Orden: primero las filas de negocio que referencian la feature por texto
-- libre (sin FK — organization_features.feature_key y
-- plan_features.feature_key no tienen constraint de integridad referencial
-- hacia features.key), luego el catálogo, luego el esquema propio del
-- widget.
-- =============================================================================

DELETE FROM public.organization_features WHERE feature_key = 'web_widget';
DELETE FROM public.plan_features WHERE feature_key = 'web_widget';
DELETE FROM public.features WHERE key = 'web_widget';

DROP TABLE IF EXISTS public.widget_session_attempts;
DROP TABLE IF EXISTS public.widget_origins;

ALTER TABLE public.organizations DROP COLUMN IF EXISTS widget_daily_session_limit;
