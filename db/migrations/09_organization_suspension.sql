-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- docs/tasks/organization-suspension.md — Suspensión de organización completa
-- (adeudo u otra causa a discreción de Datagol), distinta del kill switch
-- global por feature (`features.globally_disabled`, afecta a todos los
-- tenants) y del override por feature (`organization_features`, apaga una
-- sola feature de un solo tenant). Esto apaga TODO lo que Datagol controla
-- para un tenant específico: dashboard, tool calls y webhook de cierre de
-- llamada. No puede detener la llamada de voz en sí — ElevenLabs/Telnyx
-- corren con las credenciales propias del cliente, fuera del control de
-- Datagol (restricción rectora del proyecto, AGENTS.md).
--
-- 1. `organizations.status`: 'active' | 'suspended'. Se consulta en el mismo
--    punto donde ya se resuelve el tenant por `webhook_token`
--    (lib/tool-auth.ts, routes/webhooks/elevenlabs.ts) — cero JOINs nuevos,
--    cero latencia adicional relevante.
--
-- 2. `suspended_reason` / `suspended_at`: el CHECK obliga a que una fila
--    suspendida siempre tenga una razón registrada — defensa en profundidad,
--    la aplicación ya exige `reason` obligatorio en
--    `setOrganizationStatus()`, pero un UPDATE directo contra la base sin
--    pasar por el servicio no debería poder dejar una suspensión muda.
--
-- 3. `feature_audit_log_action_check`: agrega 'suspended' y 'reactivated' al
--    conjunto de valores permitidos. Antes de este cambio el CHECK real solo
--    permitía 'enabled', 'disabled', 'plan_changed' (types/feature-audit-actions.ts,
--    verificado contra la base) — 'kill_switch_engaged' y similares que
--    aparecían como constante local en services/entitlements.ts NUNCA
--    fueron valores válidos aquí; ver docs/tasks/organization-suspension.md
--    §"Bug preexistente" para el arreglo de ese código.
--
--    Si el nombre real del constraint en tu base difiere de
--    'feature_audit_log_action_check', el DROP...IF EXISTS de abajo es un
--    no-op silencioso y el ADD CONSTRAINT que le sigue puede fallar por
--    duplicidad de nombre, o peor, dejar el CHECK viejo intacto sin que se
--    note. Verifica primero con:
--      SELECT conname FROM pg_constraint
--      WHERE conrelid = 'public.feature_audit_log'::regclass AND contype = 'c';
-- =============================================================================

ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS suspended_reason text;

ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

ALTER TABLE public.organizations
    DROP CONSTRAINT IF EXISTS organizations_status_check;

ALTER TABLE public.organizations
    ADD CONSTRAINT organizations_status_check
    CHECK (status IN ('active', 'suspended'));

ALTER TABLE public.organizations
    DROP CONSTRAINT IF EXISTS organizations_suspended_reason_required_check;

ALTER TABLE public.organizations
    ADD CONSTRAINT organizations_suspended_reason_required_check
    CHECK (status <> 'suspended' OR (suspended_reason IS NOT NULL AND btrim(suspended_reason) <> ''));

COMMENT ON COLUMN public.organizations.status IS
    'active | suspended. Suspendida = Datagol apaga dashboard, tool calls y webhook de cierre de llamada para este tenant (adeudo u otra causa). No detiene la llamada de voz en sí (infraestructura propia del cliente, fuera del control de Datagol). Cambiar solo vía setOrganizationStatus() en services/organization-lifecycle.ts, nunca con un UPDATE directo — ese servicio es el que audita en feature_audit_log e invalida la caché de entitlements.';

COMMENT ON COLUMN public.organizations.suspended_reason IS
    'Obligatorio mientras status = suspended (CHECK organizations_suspended_reason_required_check). Se limpia al reactivar.';

COMMENT ON COLUMN public.organizations.suspended_at IS
    'Momento del UPDATE que puso status = suspended. NULL si nunca fue suspendida o si ya fue reactivada.';

ALTER TABLE public.feature_audit_log
    DROP CONSTRAINT IF EXISTS feature_audit_log_action_check;

ALTER TABLE public.feature_audit_log
    ADD CONSTRAINT feature_audit_log_action_check
    CHECK (action IN ('enabled', 'disabled', 'plan_changed', 'suspended', 'reactivated'));
