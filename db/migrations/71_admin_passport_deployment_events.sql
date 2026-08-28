-- =============================================================================
-- Datagol — Migración: evento de auditoría del pase de superadmin
-- =============================================================================
-- SSO delegado a api.datagol.net para /admin en instalaciones cliente. Cada
-- emisión de un pase (POST /control/admin-passport) deja constancia en
-- deployment_events, igual que licencia_emitida/renovado — sin esto no hay
-- forma de auditar quién entró a la instalación de qué cliente y cuándo.
--
-- No toca 55_control_plane_datagol.sql (ya aplicada) — solo amplía el CHECK
-- de deployment_events.event_type con un valor nuevo.
-- =============================================================================

ALTER TABLE public.deployment_events
    DROP CONSTRAINT IF EXISTS deployment_events_event_type_check;

ALTER TABLE public.deployment_events
    ADD CONSTRAINT deployment_events_event_type_check
    CHECK (event_type = ANY (ARRAY[
        'creado', 'contratado', 'licencia_emitida', 'licencia_revocada',
        'estado_cambiado', 'tarea_completada', 'latido_ausente', 'renovado',
        'suspendido', 'cancelado', 'nota', 'pase_admin_emitido'
    ]));
