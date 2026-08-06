-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Fase 2.1 (revisión) — El webhook de ElevenLabs pasa de resolver la
-- organización por `agent_id` (dentro del cuerpo) a resolverla por un token
-- en la ruta: POST /webhooks/elevenlabs/:webhookToken.
--
-- `webhook_token` NO es el secreto criptográfico que autentica el webhook —
-- ese sigue siendo `webhook_signing_secret` en `organization_secrets`/Vault,
-- verificado después. `webhook_token` es un identificador de enrutamiento:
-- por eso vive en una columna plana y consultable (Vault no permite buscar
-- un secreto por su valor, solo recuperarlo por nombre), y por eso su
-- filtración por sí sola no compromete nada — sin la firma HMAC válida, el
-- webhook sigue siendo rechazado con 401.
--
-- No lleva valor por defecto: el alta es un paso explícito de onboarding
-- (ver scripts/provision-org-secrets.ts), no algo que ocurra solo al crear
-- la organización.
-- =============================================================================

ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS webhook_token text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_organizations_webhook_token
    ON public.organizations (webhook_token)
    WHERE webhook_token IS NOT NULL;

COMMENT ON COLUMN public.organizations.webhook_token IS
    'Identificador de enrutamiento (no criptográfico) usado en la URL del webhook de ElevenLabs: /webhooks/elevenlabs/:webhookToken. La autenticación real la da webhook_signing_secret en organization_secrets, verificada después de resolver la organización por este token.';
