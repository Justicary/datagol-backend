-- =============================================================================
-- Datagol — Migración 65: idempotencia de inserción en appointment_waitlist
-- =============================================================================
-- AGENTS.md §4: toda operación de escritura originada en un tool call debe
-- tener clave de idempotencia con restricción UNIQUE — mismo requisito que ya
-- cubre ux_appointments_org_conversation_id para `routes/tools/booking.ts`.
-- Un reintento de ElevenLabs por respuesta lenta en `routes/tools/waitlist.ts`
-- no debe crear una segunda fila para la misma llamada.
--
-- Parcial (WHERE conversation_id IS NOT NULL): permite múltiples filas sin
-- conversationId para futuras vías de alta que no vengan de una llamada en
-- vivo (ej. captura manual desde el dashboard).
-- =============================================================================

create unique index if not exists ux_appointment_waitlist_org_conversation_id
  on appointment_waitlist (organization_id, conversation_id)
  where conversation_id is not null;
