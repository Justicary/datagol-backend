-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- `leads.pipeline_stage`: columna de la vista Kanban de /dashboard/leads
-- (datagol-frontend). Deliberadamente texto libre, SIN CHECK constraint —
-- a diferencia de `temperature`/`followup_status` (dominios fijos,
-- espejados en src/types/constraints/ del frontend), las columnas del
-- Kanban son configurables por cada organización (agregar/quitar/renombrar)
-- y viven en `organizations.integration_settings.lead_pipeline_stages`
-- (mismo patrón ya usado para `integration_settings.theme` y
-- `.business_hours`). Un `pipeline_stage` que ya no coincide con ninguna
-- columna configurada (porque el admin la borró) no es un error: el
-- frontend lo trata como perteneciente a la primera columna hasta que
-- alguien lo arrastre a otra.
--
-- NULL es el valor por defecto para todo lead existente o nuevo: el
-- frontend lo interpreta igual que un valor huérfano (primera columna) sin
-- necesidad de backfill.
-- =============================================================================

ALTER TABLE public.leads
    ADD COLUMN IF NOT EXISTS pipeline_stage text;

COMMENT ON COLUMN public.leads.pipeline_stage IS
    'Columna del tablero Kanban de /dashboard/leads en la que se encuentra el prospecto. Texto libre (id de una entrada en organizations.integration_settings.lead_pipeline_stages), NULL o huérfano = primera columna configurada. Sin CHECK constraint: las columnas son configurables por organización, no un dominio fijo.';
