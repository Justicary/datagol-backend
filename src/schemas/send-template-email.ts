import { z } from 'zod';
import { isEmailTemplateId } from '../types/email-templates.js';

/**
 * Esquemas Zod de `POST /api/organizations/:orgId/email/send-template`
 * (docs/tasks/send-template-email-backend.md).
 */

export const sendTemplateEmailParamsSchema = z.object({
    orgId: z.string().uuid(),
});
export type SendTemplateEmailParams = z.infer<typeof sendTemplateEmailParamsSchema>;

const sendTemplateEmailAttachmentSchema = z.object({
    filename: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1),
    contentBase64: z.string().min(1),
    sizeBytes: z.number().int().positive(),
});
export type SendTemplateEmailAttachment = z.infer<typeof sendTemplateEmailAttachmentSchema>;

export const sendTemplateEmailBodySchema = z.object({
    emailAccountId: z.string().uuid(),
    contactIds: z.array(z.string().uuid()).min(1).max(100),
    template: z
        .string()
        .refine(isEmailTemplateId, { message: 'template debe ser uno de: profesional, minimalista, corporativo, calido, compacto.' })
        .optional(),
    subject: z.string().trim().min(1).max(200),
    bodyMarkdown: z.string().trim().min(1).max(10000),
    replyTo: z.string().trim().email().optional(),
    attachments: z.array(sendTemplateEmailAttachmentSchema).max(5).optional(),
});
export type SendTemplateEmailBody = z.infer<typeof sendTemplateEmailBodySchema>;

export const sendTemplateEmailResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        totalRequested: z.number().int().nonnegative(),
        queued: z.number().int().nonnegative(),
        skippedOptedOut: z.number().int().nonnegative(),
        skippedNoEmail: z.number().int().nonnegative(),
        outboxIds: z.array(z.string().uuid()),
    }),
});
export type SendTemplateEmailResponse = z.infer<typeof sendTemplateEmailResponseSchema>;
