/**
 * Valores permitidos por los CHECK constraints de `leads.temperature` y
 * `leads.followup_status`. Única fuente de verdad: ningún literal de estos
 * campos debe escribirse en otro lugar del código. Verificado por inserción
 * directa contra la base real — ver __tests__/lead-enums.test.ts.
 */
export const LEAD_TEMPERATURES = {
    CALIENTE: 'caliente',
    TIBIO: 'tibio',
    FRIO: 'frio',
    NO_CALIFICADO: 'no_calificado',
} as const;

export type LeadTemperature = (typeof LEAD_TEMPERATURES)[keyof typeof LEAD_TEMPERATURES];

export const ALL_LEAD_TEMPERATURES: readonly LeadTemperature[] = Object.values(LEAD_TEMPERATURES);

export function isLeadTemperature(value: string): value is LeadTemperature {
    return (ALL_LEAD_TEMPERATURES as readonly string[]).includes(value);
}

export const LEAD_FOLLOWUP_STATUSES = {
    PENDIENTE: 'pendiente',
    EN_PROCESO: 'en_proceso',
    DESCARTADO: 'descartado',
} as const;

export type LeadFollowupStatus = (typeof LEAD_FOLLOWUP_STATUSES)[keyof typeof LEAD_FOLLOWUP_STATUSES];

export const ALL_LEAD_FOLLOWUP_STATUSES: readonly LeadFollowupStatus[] = Object.values(LEAD_FOLLOWUP_STATUSES);

export function isLeadFollowupStatus(value: string): value is LeadFollowupStatus {
    return (ALL_LEAD_FOLLOWUP_STATUSES as readonly string[]).includes(value);
}
