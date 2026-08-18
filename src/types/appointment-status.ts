/**
 * Valores permitidos por el CHECK constraint de `appointments.status`
 * (db/migrations/39_resultado_negocio.sql). Única fuente de verdad: ningún
 * literal de estado de cita debe escribirse en otro lugar del código —
 * mismo patrón que `secret-keys.ts`.
 *
 * Verificado por inserción directa contra la base real — ver
 * __tests__/appointment-status.test.ts.
 */
export const APPOINTMENT_STATUSES = {
    PROGRAMADA: 'programada',
    CONFIRMADA: 'confirmada',
    COMPLETADA: 'completada',
    NO_ASISTIO: 'no_asistio',
    CANCELADA: 'cancelada',
    REPROGRAMADA: 'reprogramada',
} as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[keyof typeof APPOINTMENT_STATUSES];

export const ALL_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = Object.values(APPOINTMENT_STATUSES);

export function isAppointmentStatus(value: string): value is AppointmentStatus {
    return (ALL_APPOINTMENT_STATUSES as readonly string[]).includes(value);
}
