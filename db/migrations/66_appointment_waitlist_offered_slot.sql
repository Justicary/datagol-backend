-- =============================================================================
-- Datagol — Migración 66: slot específico ofertado en appointment_waitlist
-- =============================================================================
-- src/services/waitlist-engine.ts necesita recordar el horario exacto del
-- cupo liberado que se ofreció (distinto de la ventana amplia
-- preferred_date_start/end que el prospecto pidió al anotarse): si la oferta
-- se rechaza o expira, el mismo horario debe poder re-ofertarse al siguiente
-- candidato de la cola sin volver a consultar qué cita se canceló
-- originalmente (esa cita ya quedó en estado 'cancelada', no es reutilizable
-- como referencia — appointments.status solo permite transicionar a
-- 'reprogramada' desde un estado final, ver
-- src/services/appointment-lifecycle.ts).
-- =============================================================================

alter table appointment_waitlist
  add column if not exists offered_slot_start timestamptz,
  add column if not exists offered_slot_end   timestamptz;

comment on column appointment_waitlist.offered_slot_start is
  'Inicio del cupo específico ofertado (distinto de preferred_date_start, que es la ventana amplia solicitada). Se copia del appointment cancelado en el momento del matchmaking.';
comment on column appointment_waitlist.offered_slot_end is
  'Fin del cupo específico ofertado.';
