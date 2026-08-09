-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- docs/tasks/outbound-lead-persistence-and-rate-limit.md — Problema 2.
--
-- `/api/voice/outbound` (y sus alias `/api/vapi/outbound`, `/api/vapi/call`)
-- no tenía ningún límite de tasa: cualquiera podía marcarle a cualquier
-- número repetidamente, sin pasar siquiera por el frontend (no tiene
-- `preHandler` de auth, es alcanzable directo). Política acordada con el
-- usuario: 3 llamadas/hora por IP de origen, 2 llamadas/día al mismo número
-- marcado, contando también los intentos que fallan.
--
-- Log de intentos, no tabla de negocio: un intento no siempre produce una
-- llamada real (puede fallar en el proveedor), así que no se reutiliza
-- `call_logs` — acoplaría el conteo de abuso a una tabla con sus propias
-- restricciones únicas de negocio. Solo la lee/escribe el backend con
-- `service_role` (nunca se expone vía API a un tenant ni al dashboard), pero
-- lleva RLS habilitada sin políticas (AGENTS.md §5: "toda tabla de negocio
-- lleva tenant_id y tiene RLS habilitada, sin excepciones") — deniega por
-- defecto a `authenticated`/`anon`, solo `service_role` la atraviesa.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.outbound_call_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid REFERENCES public.organizations(id),
    target_phone_raw text NOT NULL,
    source_ip text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbound_call_attempts_phone_created_idx
    ON public.outbound_call_attempts (target_phone_raw, created_at);
CREATE INDEX IF NOT EXISTS outbound_call_attempts_ip_created_idx
    ON public.outbound_call_attempts (source_ip, created_at);

ALTER TABLE public.outbound_call_attempts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.outbound_call_attempts IS
    'Log de intentos de llamada saliente (exitosos o no) usado únicamente para '
    'aplicar el límite de tasa de /api/voice/outbound. RLS habilitada sin '
    'políticas: solo service_role (backend) la lee/escribe.';
