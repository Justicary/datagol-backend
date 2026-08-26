-- =============================================================================
-- Datagol — Migración 67: marca de solicitud de confirmación masiva
-- =============================================================================
-- docs/tasks/waitlist_confirmacion_masiva.md, Tarea B4 (alcance v1: solo
-- notificación — decisión explícita del usuario, sin link de
-- confirmación/rechazo propio para `appointments`; la reconfirmación real se
-- sigue gestionando por el canal existente: el negocio cancela manualmente
-- en el dashboard si el cliente avisa que no asistirá, lo cual YA dispara
-- waitlist-engine.ts vía el enganche de la Tarea B3).
--
-- confirmation_requested_at evita reenviar la misma solicitud de
-- confirmación dos veces si `bulk-confirm` se invoca más de una vez para la
-- misma fecha.
-- =============================================================================

alter table appointments
  add column if not exists confirmation_requested_at timestamptz;

comment on column appointments.confirmation_requested_at is
  'Momento en que se envió (WhatsApp o voz) la solicitud de confirmación masiva de asistencia. NULL = nunca se ha solicitado. src/jobs/send-bulk-confirmation-request.ts.';
