-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Fase 5 — Tool calls en vivo (routes/tools/**).
--
-- 1. `organization_secrets.secret_key` admite ahora 'tool_webhook_secret': el
--    encabezado estático que ElevenLabs adjunta a cada invocación de un
--    "webhook tool" (ver docs/eleven-agents/customization/tools/webhook-tools),
--    configurado una sola vez por herramienta en su dashboard. Es el mismo
--    mecanismo de defensa que `webhook_signing_secret` para el webhook de
--    post-llamada, pero ElevenLabs no firma HMAC las llamadas a tools — solo
--    soporta un header estático — así que la verificación es una comparación
--    de tiempo constante, no un HMAC.
--
--    El tenant se resuelve, igual que en el webhook de post-llamada, por
--    `organizations.webhook_token` en la ruta (POST /tools/:webhookToken/...)
--    ANTES de leer el cuerpo: nunca por un `organization_id` u `agent_id` que
--    el LLM pueda alucinar o un tercero falsificar (AGENTS.md §5.1). Se
--    reutiliza la misma columna de enrutamiento del Fase 2.1 en vez de crear
--    una segunda: ambas rutas son "ElevenLabs llamando a este backend por la
--    organización X", y `webhook_token` ya está documentado como no
--    criptográfico — el secreto real en cada camino es distinto
--    (`webhook_signing_secret` vs `tool_webhook_secret`).
--
-- 2. `appointments.conversation_id`: POST /tools/booking debe ser idempotente
--    por conversation_id (AGENTS.md §5.2). Sin esta columna no hay forma de
--    detectar un reintento del agente de voz y se duplicaría la cita.
--
-- 3. `appointments.organization_id` pasa a NOT NULL. La tabla está vacía en
--    producción (verificado antes de esta migración) y todo tool call nuevo
--    resuelve el tenant de forma segura antes de insertar — no hay razón para
--    permitir una cita sin organización.
-- =============================================================================

ALTER TABLE public.organization_secrets
    DROP CONSTRAINT IF EXISTS organization_secrets_secret_key_check;

ALTER TABLE public.organization_secrets
    ADD CONSTRAINT organization_secrets_secret_key_check
    CHECK (secret_key = ANY (ARRAY[
        'elevenlabs_api_key'::text,
        'telnyx_api_key'::text,
        'whatsapp_access_token'::text,
        'cal_api_key'::text,
        'meta_app_secret'::text,
        'webhook_signing_secret'::text,
        'tool_webhook_secret'::text
    ]));

ALTER TABLE public.appointments
    ADD COLUMN IF NOT EXISTS conversation_id text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_appointments_org_conversation_id
    ON public.appointments (organization_id, conversation_id)
    WHERE conversation_id IS NOT NULL;

ALTER TABLE public.appointments
    ALTER COLUMN organization_id SET NOT NULL;

COMMENT ON COLUMN public.appointments.conversation_id IS
    'ID de conversación de ElevenLabs que originó la cita, usado como clave de idempotencia por POST /tools/:webhookToken/booking. NULL para citas creadas por flujos que no lo proveen (ej. rutas legacy de calendario).';
