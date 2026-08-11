-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Fase 5.3 — Booking sin teléfono (canal web chat).
--
-- `appointments.customer_phone` era NOT NULL (migración 07) bajo el supuesto
-- de que todo booking viene de una llamada de voz, donde el teléfono del
-- interlocutor siempre existe (caller ID del SIP trunk). El canal de web
-- chat no tiene esa garantía: un visitante puede agendar dando solo su
-- correo. `POST /tools/:webhookToken/booking` ahora exige al menos UNO de
-- los dos (teléfono o correo) — nunca ninguno — pero cuando el que falta es
-- el teléfono, la columna ya no puede rechazar el INSERT.
--
-- `contacts.phone_e164` no se toca: sigue siendo la clave real de
-- reconocimiento de contacto recurrente; un appointment sin teléfono
-- simplemente no upsertea un contact_id (mismo comportamiento ya existente
-- para teléfonos no normalizables, ver upsertContactBestEffort en
-- routes/tools/booking.ts).
-- =============================================================================

ALTER TABLE public.appointments
    ALTER COLUMN customer_phone DROP NOT NULL;

COMMENT ON COLUMN public.appointments.customer_phone IS
    'Teléfono del cliente que agendó, en el formato que haya provisto la conversación (no necesariamente E.164 normalizado). NULL cuando el booking se originó en un canal (ej. web chat) donde el cliente solo dio correo — ver POST /tools/:webhookToken/booking, que exige al menos teléfono o correo, nunca ninguno de los dos.';
