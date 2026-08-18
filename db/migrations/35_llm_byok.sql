-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 35_llm_byok.sql
-- =============================================================================
-- BYOK de LLM (docs/tasks/reportes-semanales.md, Fase A).
--
-- 1. organizations.timezone: columna nueva, IANA, default 'America/Mexico_City'.
--    A.1 del doc de tarea pedía verificar si la API v2 de Cal.com resuelve
--    esto (GET /v2/schedules/default -> campo timeZone: SÍ lo tiene), pero el
--    scheduler de reportes semanales (Fase B) filtra organizaciones por hora
--    local dentro de una consulta SQL ejecutada por pg_cron cada 6 horas —
--    pg_cron no puede llamar a la API de Cal.com por fila, así que de todos
--    modos hace falta una columna persistida en esta tabla, sin importar que
--    Cal.com también la tenga. Se agrega tal como el propio doc lo anticipa
--    como plan B. Se puede editar a mano vía
--    PATCH /api/organizations/:id/business-info, y se siembra oportunistamente
--    (best-effort, ver services/elevenlabs-timezone.ts) desde el payload de
--    ElevenLabs si en algún momento trae la zona horaria.
--
-- 2. organization_secrets.secret_key: se extiende el CHECK constraint para
--    aceptar 'llm_api_key' — la llave BYOK del cliente, guardada en Vault
--    igual que las demás (nunca en columna plana). Fuente de verdad en
--    código: src/types/secret-keys.ts.
--
-- 3. usage_events.provider: se extiende el CHECK constraint para aceptar
--    'llm'. A DIFERENCIA de organization_secrets (constraint sí rastreado en
--    este repo, ver 19_call_logs_address_and_geocoding.sql), el constraint de
--    usage_events.provider NO fue creado por ninguna migración de este
--    repositorio — su existencia se confirma solo empíricamente (ver
--    __tests__/usage-event-provider.test.ts, que espera código 23514 ante un
--    valor no permitido). Se usa aquí el nombre convencional del repo
--    (<tabla>_<columna>_check). ANTES DE APLICAR ESTA MIGRACIÓN A LA BASE
--    VIVA: confirmar el nombre real, por ejemplo con
--      SELECT conname, pg_get_constraintdef(oid)
--      FROM pg_constraint
--      WHERE conrelid = 'public.usage_events'::regclass AND contype = 'c';
--    Si el nombre real difiere, ajustar el DROP CONSTRAINT de abajo antes de
--    ejecutar — si no se ajusta, el DROP simplemente no encuentra nada
--    (IF EXISTS) y el ADD CONSTRAINT falla de forma ruidosa por nombre
--    duplicado, nunca en silencio.
--
-- 4. provider_rates: tarifa 0 para 'llm'/'llm_input_token' y
--    'llm'/'llm_output_token'. BYOK: el cliente paga directo al proveedor,
--    Datagol no cobra por estos tokens — la tarifa 0 existe solo para que
--    getRate() encuentre una fila vigente y el registro en usage_events sirva
--    para transparencia/diagnóstico (A.6), no para facturación.
-- =============================================================================

-- =============================================================================
-- BLOQUE 1 — organizations.timezone
-- =============================================================================

ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/Mexico_City';

COMMENT ON COLUMN public.organizations.timezone IS
    'Zona horaria IANA de la organización (ej. America/Mexico_City). Usada por el scheduler de reportes semanales (Fase B) para filtrar por hora local en SQL. Editable vía PATCH /api/organizations/:id/business-info; sembrada opcionalmente desde el payload de ElevenLabs (services/elevenlabs-timezone.ts).';

-- =============================================================================
-- BLOQUE 2 — organization_secrets.secret_key: agregar 'llm_api_key'
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
        'tool_webhook_secret'::text,
        'google_maps_key'::text,
        'llm_api_key'::text
    ]));

-- =============================================================================
-- BLOQUE 3 — usage_events.provider: agregar 'llm'
-- =============================================================================
-- Ver nota de verificación previa en el encabezado de este archivo.

ALTER TABLE public.usage_events
    DROP CONSTRAINT IF EXISTS usage_events_provider_check;

ALTER TABLE public.usage_events
    ADD CONSTRAINT usage_events_provider_check
    CHECK (provider = ANY (ARRAY[
        'elevenlabs'::text,
        'telnyx'::text,
        'meta'::text,
        'llm'::text
    ]));

-- =============================================================================
-- BLOQUE 4 — provider_rates: tarifa 0 para BYOK de LLM
-- =============================================================================

INSERT INTO public.provider_rates (provider, unit_type, unit_rate_usd, effective_from, notes)
VALUES
    ('llm', 'llm_input_token', 0.0000, '2026-08-17T00:00:00+00:00', 'BYOK: el cliente paga directo al proveedor de LLM. Tarifa 0 solo para que el registro en usage_events sirva de transparencia/diagnóstico (docs/tasks/reportes-semanales.md, A.6), no de facturación.'),
    ('llm', 'llm_output_token', 0.0000, '2026-08-17T00:00:00+00:00', 'BYOK: el cliente paga directo al proveedor de LLM. Tarifa 0 solo para que el registro en usage_events sirva de transparencia/diagnóstico (docs/tasks/reportes-semanales.md, A.6), no de facturación.')
ON CONFLICT DO NOTHING;
