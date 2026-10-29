/**
 * Dominios de entrega y canales de `quotation_deliveries`, `quotation_settings`
 * y `quotations.last_channel` (`db/migrations/77_quotations.sql`).
 */
export const QUOTATION_DELIVERY_CHANNELS = {
    EMAIL: 'email',
    WHATSAPP: 'whatsapp',
} as const;

export type QuotationDeliveryChannel = (typeof QUOTATION_DELIVERY_CHANNELS)[keyof typeof QUOTATION_DELIVERY_CHANNELS];

export const ALL_QUOTATION_DELIVERY_CHANNELS: readonly QuotationDeliveryChannel[] = Object.values(QUOTATION_DELIVERY_CHANNELS);

export function isQuotationDeliveryChannel(value: string): value is QuotationDeliveryChannel {
    return (ALL_QUOTATION_DELIVERY_CHANNELS as readonly string[]).includes(value);
}

export const QUOTATION_DELIVERY_STATUSES = {
    PENDIENTE: 'pendiente',
    ENVIADO: 'enviado',
    ERROR: 'error',
    OMITIDO: 'omitido',
} as const;

export type QuotationDeliveryStatus = (typeof QUOTATION_DELIVERY_STATUSES)[keyof typeof QUOTATION_DELIVERY_STATUSES];

export const ALL_QUOTATION_DELIVERY_STATUSES: readonly QuotationDeliveryStatus[] = Object.values(QUOTATION_DELIVERY_STATUSES);

export function isQuotationDeliveryStatus(value: string): value is QuotationDeliveryStatus {
    return (ALL_QUOTATION_DELIVERY_STATUSES as readonly string[]).includes(value);
}

export const QUOTATION_EMAIL_SENDERS = {
    AUTO: 'auto',
    RESEND: 'resend',
    MAILBOX: 'mailbox',
} as const;

export type QuotationEmailSender = (typeof QUOTATION_EMAIL_SENDERS)[keyof typeof QUOTATION_EMAIL_SENDERS];

export const ALL_QUOTATION_EMAIL_SENDERS: readonly QuotationEmailSender[] = Object.values(QUOTATION_EMAIL_SENDERS);

export function isQuotationEmailSender(value: string): value is QuotationEmailSender {
    return (ALL_QUOTATION_EMAIL_SENDERS as readonly string[]).includes(value);
}

export const QUOTATION_CHANNELS = {
    VOZ: 'voz',
    WHATSAPP: 'whatsapp',
    WEB: 'web',
    DASHBOARD: 'dashboard',
} as const;

export type QuotationChannel = (typeof QUOTATION_CHANNELS)[keyof typeof QUOTATION_CHANNELS];

export const ALL_QUOTATION_CHANNELS: readonly QuotationChannel[] = Object.values(QUOTATION_CHANNELS);

export function isQuotationChannel(value: string): value is QuotationChannel {
    return (ALL_QUOTATION_CHANNELS as readonly string[]).includes(value);
}
