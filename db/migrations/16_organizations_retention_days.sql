-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Retención de datos personales — pendiente documentado desde
-- docs/tasks/backend-implementation.md ("Consideraciones técnicas
-- adicionales" §3: "90 días para purga automática de transcripciones y
-- grabaciones vía pg_cron. Conservarlas indefinidamente es riesgo
-- regulatorio sin beneficio") y nunca implementado — el único pendiente con
-- exposición legal real: nombres, correos, teléfonos y transcripciones
-- completas de personas reales ya en la base, sin plazo de purga en ningún
-- lado (ni en el agente de ElevenLabs, ni aquí).
--
-- `retention_days` es por organización, no global: cada PyME cliente puede
-- tener su propio criterio (y eventualmente obligación regulatoria)
-- distinto. Gobierna cuánto tiempo se conserva el CONTENIDO con datos
-- personales (transcript/summary de call_logs, raw_payload de
-- webhook_events) — ver migración 18. El default de 90 coincide con el
-- número que ya estaba documentado como plan desde el inicio del proyecto.
--
-- CHECK > 0: un valor de 0 o negativo purgaría todo de inmediato en el
-- primer cron run — probablemente no lo que alguien quiso decir al
-- configurarlo, y catastrófico si fue un error de tipeo.
-- =============================================================================

ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS retention_days integer NOT NULL DEFAULT 90;

ALTER TABLE public.organizations
    ADD CONSTRAINT organizations_retention_days_check CHECK (retention_days > 0);

COMMENT ON COLUMN public.organizations.retention_days IS
    'Días que se conserva el contenido con datos personales (transcript/summary '
    'de call_logs, raw_payload de webhook_events) antes de que el job de '
    'pg_cron lo purgue. La fila y los datos operativos/de metering se '
    'conservan siempre — ver db/migrations/18_call_content_retention_purge.sql. '
    'Default 90, consistente con la política de retención documentada desde '
    'el inicio del proyecto.';
