-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Fase C (docs/tasks/opus.md) — routes/tools/booking.ts guarda ahora
-- `contact_address_id` (referencia a la fila real en contact_addresses,
-- reutilizable/editable) junto con `service_address` (instantánea de texto
-- de cómo se capturó en el momento de la cita — el mismo criterio que ya
-- usa customer_name/customer_email/customer_phone en esta tabla: una copia
-- histórica, no una referencia viva).
-- =============================================================================

ALTER TABLE public.appointments
    ADD COLUMN IF NOT EXISTS contact_address_id uuid REFERENCES public.contact_addresses(id);

COMMENT ON COLUMN public.appointments.contact_address_id IS
    'Referencia a la dirección real del contacto (contact_addresses) usada para esta cita, si se confirmó una. NULL si la cita no requirió dirección o el prospecto no tiene ninguna en archivo. service_address conserva el texto tal como se usó en el momento (instantánea), independiente de si esta fila luego se edita o archiva.';
