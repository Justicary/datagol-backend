/**
 * Catálogo de plantillas de correo seleccionables por organización.
 * Única fuente de verdad: ningún literal suelto debe escribirse en otro lugar.
 * Sigue el patrón de `secret-keys.ts`.
 */
export const EMAIL_TEMPLATES = {
    PROFESIONAL: 'profesional',
    MINIMALISTA: 'minimalista',
    CORPORATIVO: 'corporativo',
    CALIDO: 'calido',
    COMPACTO: 'compacto',
} as const;

export type EmailTemplateId = (typeof EMAIL_TEMPLATES)[keyof typeof EMAIL_TEMPLATES];

export const ALL_EMAIL_TEMPLATES: readonly EmailTemplateId[] = Object.values(EMAIL_TEMPLATES);

export function isEmailTemplateId(value: string): value is EmailTemplateId {
    return (ALL_EMAIL_TEMPLATES as readonly string[]).includes(value);
}

/**
 * Catálogo de tipos de correo generados por el backend.
 */
export const EMAIL_TYPES = {
    CALL_SUMMARY: 'call_summary',
    HOT_LEAD: 'hot_lead',
    APPOINTMENT_CONFIRMATION: 'appointment_confirmation',
    PROSPECT_SUMMARY: 'prospect_summary',
    CREDITS_ALERT: 'credits_alert',
    THANK_YOU: 'thank_you',
} as const;

export type EmailTypeId = (typeof EMAIL_TYPES)[keyof typeof EMAIL_TYPES];

export const ALL_EMAIL_TYPES: readonly EmailTypeId[] = Object.values(EMAIL_TYPES);

export function isEmailTypeId(value: string): value is EmailTypeId {
    return (ALL_EMAIL_TYPES as readonly string[]).includes(value);
}

/**
 * Configuración de correo persistida en `organizations.integration_settings.email`.
 */
export interface OrganizationEmailSettings {
    template?: EmailTemplateId | string | null;
    logoUrl?: string | null;
    footerText?: string | null;
    replyTo?: string | null;
}

/**
 * Datos para el correo de resumen ejecutivo de llamada.
 */
export interface CallSummaryEmailData {
    callerPhone?: string | null;
    summary: string;
    sentiment?: string | null;
    durationSeconds?: number | null;
    transcript?: string | null;
    nextSteps?: string[] | null;
    businessName?: string | null;
}

/**
 * Datos para la alerta de prospecto caliente sin cita.
 */
export interface HotLeadEmailData {
    leadName?: string | null;
    leadPhone?: string | null;
    businessName?: string | null;
    inquiryReason?: string | null;
    followupNotes?: string | null;
}

/**
 * Datos para la confirmación de cita agendada.
 */
export interface AppointmentConfirmationEmailData {
    customerName: string;
    customerPhone?: string | null;
    customerEmail?: string | null;
    startTime: string;
    endTime?: string | null;
    businessName?: string | null;
    serviceAddress?: string | null;
    notes?: string | null;
}

/**
 * Datos para el resumen de cortesía enviado al prospecto.
 */
export interface ProspectSummaryEmailData {
    prospectName?: string | null;
    businessName?: string | null;
    summary?: string | null;
    followupNotes?: string | null;
}

/**
 * Datos para la alerta de créditos de ElevenLabs por agotarse.
 */
export interface CreditsAlertEmailData {
    organizationName?: string | null;
    remainingPercentage: number;
    threshold: number;
}

/**
 * Datos para el correo de agradecimiento automático enviado al prospecto.
 */
export interface ThankYouEmailData {
    prospectName?: string | null;
    businessName?: string | null;
    customSubject?: string | null;
    customBody?: string | null;
    attachmentDownloadUrl?: string | null;
    attachmentFileName?: string | null;
}

export type EmailDataPayload =
    | { type: typeof EMAIL_TYPES.CALL_SUMMARY; data: CallSummaryEmailData }
    | { type: typeof EMAIL_TYPES.HOT_LEAD; data: HotLeadEmailData }
    | { type: typeof EMAIL_TYPES.APPOINTMENT_CONFIRMATION; data: AppointmentConfirmationEmailData }
    | { type: typeof EMAIL_TYPES.PROSPECT_SUMMARY; data: ProspectSummaryEmailData }
    | { type: typeof EMAIL_TYPES.CREDITS_ALERT; data: CreditsAlertEmailData }
    | { type: typeof EMAIL_TYPES.THANK_YOU; data: ThankYouEmailData };
