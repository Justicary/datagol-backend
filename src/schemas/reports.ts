import { z } from 'zod';
import { REPORT_CHANNELS, REPORT_TYPES, REPORT_STATUSES } from '../types/reports.js';

export const reportChannelEnum = z.enum([REPORT_CHANNELS.EMAIL, REPORT_CHANNELS.WHATSAPP]);

export const reportTypeEnum = z.enum([REPORT_TYPES.PLANNING, REPORT_TYPES.EXECUTIVE]);

export const reportStatusEnum = z.enum([
    REPORT_STATUSES.GENERATING,
    REPORT_STATUSES.GENERATED,
    REPORT_STATUSES.NARRATIVE_FALLBACK,
    REPORT_STATUSES.SKIPPED_NO_ACTIVITY,
    REPORT_STATUSES.FAILED,
]);

const reportScheduleSettingsSchema = z.object({
    enabled: z.boolean().default(true),
    dayOfWeek: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    channels: z.array(reportChannelEnum).min(1),
});

/**
 * Esquema de configuración en `organizations.integration_settings.reports`.
 */
export const organizationReportsSettingsSchema = z.object({
    planning: reportScheduleSettingsSchema,
    executive: reportScheduleSettingsSchema,
    whatsappTemplateName: z.string().max(100).nullable().optional(),
    whatsappRecipientPhone: z.string().max(20).nullable().optional(),
});
export type OrganizationReportsSettingsDTO = z.infer<typeof organizationReportsSettingsSchema>;

/**
 * Esquema para PATCH /organizations/:id/reports-config — cada rama de
 * configuración es parcial, igual que organizationThankYouUpdateSchema.
 */
export const organizationReportsUpdateSchema = z.object({
    planning: reportScheduleSettingsSchema.partial().optional(),
    executive: reportScheduleSettingsSchema.partial().optional(),
    whatsappTemplateName: z.string().max(100).nullable().optional(),
    whatsappRecipientPhone: z.string().max(20).nullable().optional(),
});
export type OrganizationReportsUpdateDTO = z.infer<typeof organizationReportsUpdateSchema>;

export const reportsConfigResponseSchema = z.object({
    success: z.literal(true),
    data: organizationReportsSettingsSchema,
});

/**
 * Esquema para GET /organizations/:id/reports
 */
export const reportsListQuerySchema = z.object({
    reportType: reportTypeEnum.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ReportsListQuery = z.infer<typeof reportsListQuerySchema>;

export const reportListItemSchema = z.object({
    id: z.string().uuid(),
    reportType: reportTypeEnum,
    weekStart: z.string(),
    status: reportStatusEnum,
    generatedAt: z.string().nullable(),
    hasDownload: z.boolean(),
});

export const reportsListResponseSchema = z.object({
    success: z.literal(true),
    data: z.array(reportListItemSchema),
});

export const reportIdParamSchema = z.object({
    id: z.string().uuid('El parámetro id debe ser un UUID válido'),
    reportId: z.string().uuid('El parámetro reportId debe ser un UUID válido'),
});

export const reportsPreviewQuerySchema = z.object({
    type: reportTypeEnum.default(REPORT_TYPES.PLANNING),
});
export type ReportsPreviewQuery = z.infer<typeof reportsPreviewQuerySchema>;

export const reportsPreviewResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        reportType: reportTypeEnum,
        subject: z.string(),
        html: z.string(),
        text: z.string().optional(),
    }),
});
