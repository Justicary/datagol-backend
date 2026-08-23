-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 54_email_outbox_attachments.sql
-- =============================================================================
-- Despacho de correo con plantilla personalizada a contactos
-- (docs/tasks/send-template-email-backend.md): agrega a `email_outbox` los
-- dos campos que el worker asíncrono `send-template-email`
-- (src/jobs/send-template-email.ts) necesita releer a partir del `outboxId`
-- — mismo criterio "job data mínimo, todo lo demás se relee de la fila" que
-- `send-thank-you.ts` — porque ninguno de los dos existía en la tabla
-- original de la migración 53 (pensada para el despacho 1-a-1 del agente,
-- sin adjuntos ni reply-to distinto del buzón emisor).
-- =============================================================================

ALTER TABLE public.email_outbox ADD COLUMN IF NOT EXISTS attachments jsonb;
ALTER TABLE public.email_outbox ADD COLUMN IF NOT EXISTS reply_to text;

COMMENT ON COLUMN public.email_outbox.attachments IS
    'Adjuntos efímeros del envío: array de {filename, contentType, contentBase64}. NULL para correos sin adjuntos. No es un archivo persistente reusable (a diferencia de organization_attachments) — vive solo mientras el job de envío no ha corrido.';
COMMENT ON COLUMN public.email_outbox.reply_to IS
    'Reply-To explícito del envío (payload.replyTo o organizations.integration_settings.email.replyTo). NULL usa el remitente del buzón por defecto.';
