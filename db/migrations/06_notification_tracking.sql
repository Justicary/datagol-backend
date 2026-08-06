-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Fase 4 — Notificaciones. Los jobs notify-hot-lead, send-call-summary y
-- send-prospect-summary son idempotentes y reintentables (AGENTS.md §8), pero
-- el esquema no tenía ninguna columna para saber si una notificación ya se
-- entregó. Sin esto, un reintento de pg-boss (o un re-enqueue del job desde
-- process-call-completed en un reintento de webhook) reenviaría el correo.
--
-- Se agregan tres columnas nullable de "ya se envió" (mismo patrón que
-- webhook_events.processed_at): NULL = pendiente, timestamptz = entregado.
-- Cada worker las revisa ANTES de enviar y las fija DESPUÉS de un envío
-- exitoso, con el filtro `IS NULL` en el propio UPDATE como salvaguarda
-- adicional ante ejecuciones concurrentes.
-- =============================================================================

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS hot_lead_notified_at timestamptz;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS prospect_summary_sent_at timestamptz;
ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS call_summary_sent_at timestamptz;

COMMENT ON COLUMN public.leads.hot_lead_notified_at IS
    'Marca de tiempo de envío exitoso de la alerta de prospecto caliente (job notify-hot-lead, Fase 4.1). NULL = aún no notificado.';

COMMENT ON COLUMN public.leads.prospect_summary_sent_at IS
    'Marca de tiempo de envío exitoso del resumen al prospecto (job send-prospect-summary, Fase 4.3). NULL = aún no enviado.';

COMMENT ON COLUMN public.call_logs.call_summary_sent_at IS
    'Marca de tiempo de envío exitoso de la minuta por correo al negocio (job send-call-summary, Fase 4.2). NULL = aún no enviado.';
