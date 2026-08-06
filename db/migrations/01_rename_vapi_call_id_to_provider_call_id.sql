-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Renombra la columna vapi_call_id a provider_call_id en la tabla call_logs
-- para permitir el almacenamiento agnóstico de llamadas de voz (ElevenLabs, Vapi, etc.)
-- =============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'call_logs'
        AND column_name = 'vapi_call_id'
    ) THEN
        ALTER TABLE public.call_logs RENAME COLUMN vapi_call_id TO provider_call_id;
        RAISE NOTICE 'Columna vapi_call_id renombrada exitosamente a provider_call_id';
    ELSE
        RAISE NOTICE 'La columna provider_call_id ya existe o vapi_call_id no fue encontrada';
    END IF;
END $$;
