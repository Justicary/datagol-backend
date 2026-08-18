-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 37_weekly_reports_status_generating.sql
-- =============================================================================
-- Corrige weekly_reports.status: la migración 36 se aplicó a la base viva
-- ANTES de agregar el estado 'generating' (reclamo atómico del slot semanal
-- en weekly-report-service.ts, INSERT con status='generating' seguido de un
-- UPDATE al estado final — ver src/services/weekly-report-service.ts). El
-- CHECK constraint original solo permitía
-- ('generated','narrative_fallback','skipped_no_activity','failed'), así que
-- el INSERT de reclamo violaba el constraint (código 23514) en vez de
-- reclamar el slot.
--
-- db/migrations/36_weekly_reports.sql en este repositorio YA incluye
-- 'generating' en su CREATE TABLE — esta migración solo es necesaria para
-- bases que ya corrieron la 36 antes de ese ajuste. `CREATE TABLE IF NOT
-- EXISTS` no modifica una tabla que ya existe, así que hace falta este
-- ALTER TABLE explícito, no re-correr el archivo 36 completo (que además
-- fallaría por las políticas RLS ya creadas, `CREATE POLICY` no admite
-- `IF NOT EXISTS`).
-- =============================================================================

ALTER TABLE public.weekly_reports
    DROP CONSTRAINT IF EXISTS weekly_reports_status_check;

ALTER TABLE public.weekly_reports
    ADD CONSTRAINT weekly_reports_status_check
    CHECK (status IN ('generating', 'generated', 'narrative_fallback', 'skipped_no_activity', 'failed'));
