/**
 * Valores permitidos por los CHECK constraints de `appointment_waitlist`
 * (db/migrations/64_appointment_waitlist.sql). Única fuente de verdad: ningún
 * literal de estado o prioridad de lista de espera debe escribirse en otro
 * lugar del código — mismo patrón que `appointment-status.ts`.
 */
export const WAITLIST_STATUSES = {
    PENDIENTE: 'pendiente',
    OFERTADA: 'ofertada',
    CONFIRMADA: 'confirmada',
    RECHAZADA: 'rechazada',
    EXPIRADA: 'expirada',
    CANCELADA: 'cancelada',
} as const;

export type WaitlistStatus = (typeof WAITLIST_STATUSES)[keyof typeof WAITLIST_STATUSES];

export const ALL_WAITLIST_STATUSES: readonly WaitlistStatus[] = Object.values(WAITLIST_STATUSES);

export function isWaitlistStatus(value: string): value is WaitlistStatus {
    return (ALL_WAITLIST_STATUSES as readonly string[]).includes(value);
}

export const WAITLIST_PRIORITIES = {
    ALTA: 'alta',
    NORMAL: 'normal',
    BAJA: 'baja',
} as const;

export type WaitlistPriority = (typeof WAITLIST_PRIORITIES)[keyof typeof WAITLIST_PRIORITIES];

export const ALL_WAITLIST_PRIORITIES: readonly WaitlistPriority[] = Object.values(WAITLIST_PRIORITIES);

export const WAITLIST_NOTIFICATION_CHANNELS = {
    WHATSAPP: 'whatsapp',
    VOICE: 'voice',
    SMS: 'sms',
} as const;

export type WaitlistNotificationChannel =
    (typeof WAITLIST_NOTIFICATION_CHANNELS)[keyof typeof WAITLIST_NOTIFICATION_CHANNELS];
