-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 72_jev_byok.sql
-- =============================================================================
-- BYOK de Jev (TypeSafe AI) vía OpenRouter.
--
-- Cada organización aporta su propia cuenta de OpenRouter para usar Jev
-- (modelo de juicios tipados: probabilidad / opción / escala). Es una
-- configuración APARTE del LLM BYOK de 35_llm_byok.sql: Jev no redacta
-- texto, así que no puede sustituir al modelo que genera reportes semanales
-- y narrativas. Por eso la llave vive en su propia clave de secreto,
-- 'jev_api_key', guardada en Vault igual que las demás (nunca en columna
-- plana). Fuente de verdad en código: src/types/secret-keys.ts.
--
-- No toca 35_llm_byok.sql (ya aplicada) — solo amplía el CHECK de
-- organization_secrets.secret_key con un valor nuevo.
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
        'llm_api_key'::text,
        'jev_api_key'::text
    ]));
