-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Alertas de créditos de ElevenLabs por organización (15%/10%/5% restante).
--
-- Dedup por ciclo de facturación: `cycle_reset_at` es
-- `next_character_count_reset_unix` de la respuesta de
-- GET /v1/user/subscription convertido a timestamptz. Mientras ese valor no
-- cambie seguimos en el mismo ciclo — el UNIQUE (organization_id, alert_type,
-- cycle_reset_at) es lo que evita reenviar el mismo umbral dos veces dentro
-- del mismo ciclo. Cuando ElevenLabs resetea el ciclo, `cycle_reset_at`
-- cambia y los tres umbrales vuelven a estar disponibles para notificarse.
--
-- Solo la escribe/lee el job de `datagol-backend` con `service_role` (ver
-- src/jobs/check-elevenlabs-credits.ts) — no se expone vía API a un tenant ni
-- al dashboard todavía. RLS habilitada sin políticas (mismo patrón que
-- `outbound_call_attempts`, migración 12, y AGENTS.md §5: "toda tabla de
-- negocio lleva tenant_id y tiene RLS habilitada, sin excepciones"): deniega
-- por defecto a `authenticated`/`anon`, solo `service_role` la atraviesa.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.organization_usage_alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    alert_type text NOT NULL CHECK (alert_type IN (
        'elevenlabs_credits_15',
        'elevenlabs_credits_10',
        'elevenlabs_credits_5'
    )),
    cycle_reset_at timestamptz NOT NULL,
    sent_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, alert_type, cycle_reset_at)
);

CREATE INDEX IF NOT EXISTS organization_usage_alerts_org_idx
    ON public.organization_usage_alerts (organization_id);

ALTER TABLE public.organization_usage_alerts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.organization_usage_alerts IS
    'Registro de alertas de créditos de ElevenLabs (15%/10%/5% restante) ya '
    'enviadas por organización y ciclo de facturación — evita reenviar el '
    'mismo umbral dos veces dentro del mismo ciclo. RLS habilitada sin '
    'políticas: solo service_role la atraviesa.';
