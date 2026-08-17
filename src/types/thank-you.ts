/**
-- =============================================================================
-- Tipos y constantes canónicas para el módulo de Agradecimiento Automático
-- =============================================================================
*/

export const THANK_YOU_CHANNELS = {
    EMAIL: 'email',
    WHATSAPP: 'whatsapp',
} as const;

export type ThankYouChannel = (typeof THANK_YOU_CHANNELS)[keyof typeof THANK_YOU_CHANNELS];

export const ALL_THANK_YOU_CHANNELS: readonly ThankYouChannel[] = Object.values(THANK_YOU_CHANNELS);

export function isThankYouChannel(value: string): value is ThankYouChannel {
    return (ALL_THANK_YOU_CHANNELS as readonly string[]).includes(value);
}

export const THANK_YOU_STATUSES = {
    PENDIENTE: 'pendiente',
    ENVIADO: 'enviado',
    FALLIDO: 'fallido',
    OMITIDO: 'omitido',
} as const;

export type ThankYouStatus = (typeof THANK_YOU_STATUSES)[keyof typeof THANK_YOU_STATUSES];

export const ALL_THANK_YOU_STATUSES: readonly ThankYouStatus[] = Object.values(THANK_YOU_STATUSES);

export function isThankYouStatus(value: string): value is ThankYouStatus {
    return (ALL_THANK_YOU_STATUSES as readonly string[]).includes(value);
}

export const THANK_YOU_SKIP_REASONS = {
    NO_CONTACT_INFO: 'sin_datos_de_contacto',
    OPTED_OUT: 'contacto_opted_out',
    DEDUPE_WINDOW: 'en_ventana_deduplicacion',
    FEATURE_DISABLED: 'feature_desactivada',
    SETTINGS_DISABLED: 'agradecimiento_desactivado',
    NO_TEMPLATE_OUTSIDE_WINDOW: 'sin_plantilla_aprobada_fuera_de_ventana',
    ATTACHMENT_NOT_FOUND: 'adjunto_no_encontrado',
    SEND_FAILED: 'fallo_al_enviar',
} as const;

export type ThankYouSkipReason = (typeof THANK_YOU_SKIP_REASONS)[keyof typeof THANK_YOU_SKIP_REASONS];

/**
 * Configuración persistida en `organizations.integration_settings.thankYou`.
 */
export interface OrganizationThankYouSettings {
    enabled: boolean;
    dedupeWindowDays: number;
    emailSubject?: string | null;
    emailBody?: string | null;
    whatsappTemplateName?: string | null;
    attachmentId?: string | null;
}

/**
 * Registro de un documento adjunto en `organization_attachments`.
 */
export interface OrganizationAttachmentRecord {
    id: string;
    organization_id: string;
    file_name: string;
    mime_type: string;
    size_bytes: number;
    storage_path: string;
    is_active: boolean;
    uploaded_by: string | null;
    created_at: string;
    archived_at: string | null;
}

/**
 * Registro de auditoría y deduplicación en `thank_you_sends`.
 */
export interface ThankYouSendRecord {
    id: string;
    organization_id: string;
    contact_id: string;
    lead_id: string | null;
    channel: ThankYouChannel;
    status: ThankYouStatus;
    skip_reason: string | null;
    attachment_id: string | null;
    sent_at: string | null;
    created_at: string;
}
