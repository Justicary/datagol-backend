-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Agrega las columnas customer_name y customer_email a la tabla call_logs
-- para almacenar la información de contacto del prospecto en todas las llamadas,
-- independientemente de si agendó cita o no.
-- =============================================================================

ALTER TABLE public.call_logs
ADD COLUMN IF NOT EXISTS customer_name varchar,
ADD COLUMN IF NOT EXISTS customer_email varchar;

COMMENT ON COLUMN public.call_logs.customer_name IS 'Nombre completo del prospecto capturado durante la llamada';
COMMENT ON COLUMN public.call_logs.customer_email IS 'Correo electrónico del prospecto capturado durante la llamada';
