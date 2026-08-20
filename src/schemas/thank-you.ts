import { z } from 'zod';
import { THANK_YOU_CHANNELS, THANK_YOU_STATUSES } from '../types/thank-you.js';

export const thankYouChannelEnum = z.enum([
    THANK_YOU_CHANNELS.EMAIL,
    THANK_YOU_CHANNELS.WHATSAPP,
]);

export const thankYouStatusEnum = z.enum([
    THANK_YOU_STATUSES.PENDIENTE,
    THANK_YOU_STATUSES.ENVIADO,
    THANK_YOU_STATUSES.FALLIDO,
    THANK_YOU_STATUSES.OMITIDO,
]);

/**
 * Esquema de configuración de agradecimiento en `organizations.integration_settings.thankYou`.
 */
export const organizationThankYouSettingsSchema = z.object({
    enabled: z.boolean().default(false),
    dedupeWindowDays: z.number().int().min(1).max(365).default(30),
    emailSubject: z.string().max(200, 'El asunto no puede exceder 200 caracteres').nullable().optional(),
    emailBody: z.string().max(4000, 'El cuerpo del correo no puede exceder 4000 caracteres').nullable().optional(),
    whatsappTemplateName: z.string().max(100, 'El nombre de la plantilla de WhatsApp no puede exceder 100 caracteres').nullable().optional(),
    attachmentId: z.string().uuid('attachmentId debe ser un UUID válido').nullable().optional(),
});

export type OrganizationThankYouSettingsDTO = z.infer<typeof organizationThankYouSettingsSchema>;

/**
 * Esquema para PATCH /organizations/:id/thank-you
 */
export const organizationThankYouUpdateSchema = organizationThankYouSettingsSchema.partial();

export type OrganizationThankYouUpdateDTO = z.infer<typeof organizationThankYouUpdateSchema>;

/**
 * Esquema para POST /organizations/:id/thank-you/test
 */
export const thankYouTestBodySchema = z.object({
    channel: thankYouChannelEnum.default(THANK_YOU_CHANNELS.EMAIL),
    to: z.string().min(1, 'El destinatario de prueba (correo o teléfono) es requerido').optional(),
});

export type ThankYouTestBody = z.infer<typeof thankYouTestBodySchema>;

/**
 * Esquema de parámetros para GET /organizations/:id/thank-you/log
 */
export const thankYouLogQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: thankYouStatusEnum.optional(),
    channel: thankYouChannelEnum.optional(),
});

export type ThankYouLogQuery = z.infer<typeof thankYouLogQuerySchema>;

/**
 * Esquema de parámetros de ruta de organización.
 */
export const orgIdParamSchema = z.object({
    id: z.string().uuid('El parámetro id debe ser un UUID válido'),
});

export const orgAttachmentParamSchema = z.object({
    id: z.string().uuid('El parámetro id debe ser un UUID válido'),
    attId: z.string().uuid('El parámetro attId debe ser un UUID válido'),
});

/**
 * Esquema de parámetros para DELETE /api/organizations/:id/thank-you/log/:sendId
 */
export const orgSendParamSchema = z.object({
    id: z.string().uuid('El parámetro id debe ser un UUID válido'),
    sendId: z.string().uuid('El parámetro sendId debe ser un UUID válido'),
});

/**
 * Esquema de cuerpo para POST /api/organizations/:id/thank-you/resend
 */
export const thankYouResendBodySchema = z
    .object({
        sendId: z.string().uuid('sendId debe ser un UUID válido').optional(),
        contactId: z.string().uuid('contactId debe ser un UUID válido').optional(),
        email: z.string().email('Debe ser un correo electrónico válido').optional(),
    })
    .refine((data) => Boolean(data.sendId || data.contactId || data.email), {
        message: 'Se requiere al menos sendId, contactId o email para reenviar el agradecimiento',
    });

export type ThankYouResendBody = z.infer<typeof thankYouResendBodySchema>;
