import { z } from 'zod';
import { EMAIL_TEMPLATES, EMAIL_TYPES } from '../types/email-templates.js';

export const emailTemplateEnum = z.enum([
    EMAIL_TEMPLATES.PROFESIONAL,
    EMAIL_TEMPLATES.MINIMALISTA,
    EMAIL_TEMPLATES.CORPORATIVO,
    EMAIL_TEMPLATES.CALIDO,
    EMAIL_TEMPLATES.COMPACTO,
]);

export const emailTypeEnum = z.enum([
    EMAIL_TYPES.CALL_SUMMARY,
    EMAIL_TYPES.HOT_LEAD,
    EMAIL_TYPES.APPOINTMENT_CONFIRMATION,
    EMAIL_TYPES.PROSPECT_SUMMARY,
    EMAIL_TYPES.CREDITS_ALERT,
    EMAIL_TYPES.THANK_YOU,
]);

/**
 * Esquema de configuración de correo en `organizations.integration_settings.email`.
 */
export const organizationEmailSettingsSchema = z.object({
    template: emailTemplateEnum.default(EMAIL_TEMPLATES.PROFESIONAL),
    logoUrl: z
        .string()
        .url('El logo debe ser una URL válida')
        .regex(/^https:\/\//, 'El logo debe ser una URL HTTPS segura (https://...)')
        .max(2048, 'La URL del logo no puede exceder 2048 caracteres')
        .nullable()
        .optional(),
    footerText: z.string().max(500, 'El texto del pie no puede exceder 500 caracteres').nullable().optional(),
    replyTo: z.string().email('replyTo debe ser una dirección de correo válida').nullable().optional(),
});

export type OrganizationEmailSettingsDTO = z.infer<typeof organizationEmailSettingsSchema>;

/**
 * Parámetros de consulta para GET /organizations/:id/email/preview
 */
export const emailPreviewQuerySchema = z.object({
    template: emailTemplateEnum.optional(),
    type: emailTypeEnum.default(EMAIL_TYPES.CALL_SUMMARY),
});

export type EmailPreviewQuery = z.infer<typeof emailPreviewQuerySchema>;

/**
 * Cuerpo para POST /organizations/:id/email/test
 */
export const emailTestBodySchema = z.object({
    template: emailTemplateEnum.optional(),
    type: emailTypeEnum.default(EMAIL_TYPES.CALL_SUMMARY),
    to: z.string().email('Dirección de correo inválida').optional(),
});

export type EmailTestBody = z.infer<typeof emailTestBodySchema>;

/**
 * Esquema de respuesta para la previsualización.
 */
export const emailPreviewResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        template: emailTemplateEnum,
        type: emailTypeEnum,
        subject: z.string(),
        html: z.string(),
        text: z.string(),
    }),
});

/**
 * Esquema de respuesta para el envío de prueba.
 */
export const emailTestResponseSchema = z.object({
    success: z.literal(true),
    message: z.string(),
    data: z.object({
        template: emailTemplateEnum,
        type: emailTypeEnum,
        recipient: z.string(),
        emailId: z.string().optional(),
    }),
});
