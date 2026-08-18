import { APPOINTMENT_STATUSES, type AppointmentStatus } from '../types/appointment-status.js';

const FINAL_STATUSES: ReadonlySet<AppointmentStatus> = new Set([
    APPOINTMENT_STATUSES.COMPLETADA,
    APPOINTMENT_STATUSES.NO_ASISTIO,
    APPOINTMENT_STATUSES.CANCELADA,
]);

/**
 * Matriz de transición de `appointments.status`
 * (docs/tasks/asistencia-valor de cierre.md, B.1): desde un estado no-final
 * (`programada`/`confirmada`/`reprogramada`) se puede ir a cualquier otro;
 * desde un estado final, solo a `reprogramada`.
 *
 * `reprogramada` se trata como NO-final aunque el doc solo menciona
 * `programada`/`confirmada` como orígenes válidos: `calendar.ts` y
 * `routes/tools/reschedule.ts` ya la usan como el estado resultante de un
 * reagendado exitoso (la cita sigue viva, en su nueva fecha) — tratarla
 * como terminal impediría confirmarla o completarla después.
 */
export function isValidStatusTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
    if (from === to) return true;
    if (!FINAL_STATUSES.has(from)) return true;
    return to === APPOINTMENT_STATUSES.REPROGRAMADA;
}

/**
 * `completada`/`no_asistio` en una cita cuyo `start_time` todavía no ocurre
 * es un error de captura, no un caso de uso real (B.1) — se rechaza.
 */
export function isFutureCompletionAttempt(status: AppointmentStatus, startTime: Date, now: Date = new Date()): boolean {
    return (status === APPOINTMENT_STATUSES.COMPLETADA || status === APPOINTMENT_STATUSES.NO_ASISTIO) && startTime > now;
}
