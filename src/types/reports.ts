/**
-- =============================================================================
-- Tipos y constantes canónicas para los Reportes Semanales
-- (docs/tasks/reportes-semanales.md, Fase B)
-- =============================================================================
*/

export const REPORT_TYPES = {
    PLANNING: 'planning',
    EXECUTIVE: 'executive',
} as const;

export type ReportType = (typeof REPORT_TYPES)[keyof typeof REPORT_TYPES];

export const ALL_REPORT_TYPES: readonly ReportType[] = Object.values(REPORT_TYPES);

export function isReportType(value: string): value is ReportType {
    return (ALL_REPORT_TYPES as readonly string[]).includes(value);
}

export const REPORT_CHANNELS = {
    EMAIL: 'email',
    WHATSAPP: 'whatsapp',
} as const;

export type ReportChannel = (typeof REPORT_CHANNELS)[keyof typeof REPORT_CHANNELS];

export const ALL_REPORT_CHANNELS: readonly ReportChannel[] = Object.values(REPORT_CHANNELS);

export function isReportChannel(value: string): value is ReportChannel {
    return (ALL_REPORT_CHANNELS as readonly string[]).includes(value);
}

/**
 * Estado de un `weekly_reports` — refleja tanto el resultado de la
 * generación (B.3) como el registro de idempotencia (B.1): la fila existe
 * en cuanto se reclama el slot semanal, sin importar cómo termine.
 */
export const REPORT_STATUSES = {
    /** Fila de reclamo atómico (`INSERT ... ON CONFLICT DO NOTHING`) antes de generar — ver weekly-report-service.ts. */
    GENERATING: 'generating',
    GENERATED: 'generated',
    NARRATIVE_FALLBACK: 'narrative_fallback',
    SKIPPED_NO_ACTIVITY: 'skipped_no_activity',
    FAILED: 'failed',
} as const;

export type ReportStatus = (typeof REPORT_STATUSES)[keyof typeof REPORT_STATUSES];

export const ALL_REPORT_STATUSES: readonly ReportStatus[] = Object.values(REPORT_STATUSES);

export function isReportStatus(value: string): value is ReportStatus {
    return (ALL_REPORT_STATUSES as readonly string[]).includes(value);
}

/**
 * Configuración de un tipo de reporte dentro de
 * `organizations.integration_settings.reports.<planning|executive>`.
 */
export interface ReportScheduleSettings {
    enabled: boolean;
    /** 0 = domingo … 6 = sábado (mismo dominio que EXTRACT(DOW) de Postgres). */
    dayOfWeek: number;
    /** Hora local, 0-23. */
    hour: number;
    channels: ReportChannel[];
}

/**
 * Configuración persistida en `organizations.integration_settings.reports`.
 */
export interface OrganizationReportsSettings {
    planning: ReportScheduleSettings;
    executive: ReportScheduleSettings;
    /** Nombre de la plantilla de WhatsApp aprobada por Meta para el resumen corto (B.4). */
    whatsappTemplateName?: string | null;
    /**
     * Teléfono E.164 del admin que recibe el resumen por WhatsApp — los
     * reportes no están atados a un `contact_id` del CRM (no son un
     * prospecto), así que no pueden reutilizar el destino de un contacto.
     * Si no se configura, cae a `organizations.phone_number`.
     */
    whatsappRecipientPhone?: string | null;
}

export const DEFAULT_REPORTS_SETTINGS: OrganizationReportsSettings = {
    planning: { enabled: true, dayOfWeek: 1, hour: 6, channels: [REPORT_CHANNELS.EMAIL] },
    executive: { enabled: true, dayOfWeek: 5, hour: 18, channels: [REPORT_CHANNELS.EMAIL] },
    whatsappTemplateName: null,
    whatsappRecipientPhone: null,
};

export const REPORT_SKIP_REASONS = {
    NO_TEMPLATE_CONFIGURED: 'sin_plantilla_configurada',
    CHANNEL_DISABLED: 'canal_desactivado',
    NO_CONTACT_INFO: 'sin_datos_de_contacto',
} as const;

export type ReportSkipReason = (typeof REPORT_SKIP_REASONS)[keyof typeof REPORT_SKIP_REASONS];

/**
 * Registro de entrega por canal, persistido en `weekly_reports.delivery_log`.
 */
export interface ReportDeliveryLogEntry {
    status: 'sent' | 'omitted' | 'failed';
    reason?: ReportSkipReason | string;
    sentAt?: string;
}

export type ReportDeliveryLog = Partial<Record<ReportChannel, ReportDeliveryLogEntry>>;

/**
 * Fila de `weekly_reports`.
 */
export interface WeeklyReportRecord {
    id: string;
    organization_id: string;
    report_type: ReportType;
    week_start: string;
    status: ReportStatus;
    data: Record<string, unknown>;
    narrative: string | null;
    storage_path: string | null;
    file_size_bytes: number | null;
    delivery_log: ReportDeliveryLog;
    error: string | null;
    generated_at: string | null;
    created_at: string;
}
