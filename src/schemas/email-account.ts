import { z } from 'zod';

/**
 * Esquemas Zod de `routes/admin/email-accounts.ts` — CRUD de buzones
 * IMAP/SMTP por organización (docs/tasks/native-mail-integration.md §3).
 * A diferencia de `schemas/email.ts` (plantillas transaccionales de Resend),
 * este archivo es exclusivo de la integración de correo nativa.
 */

export const emailAccountOrgParamsSchema = z.object({
    orgId: z.string().uuid(),
});
export type EmailAccountOrgParams = z.infer<typeof emailAccountOrgParamsSchema>;

export const emailAccountDeleteParamsSchema = z.object({
    orgId: z.string().uuid(),
    accountId: z.string().uuid(),
});
export type EmailAccountDeleteParams = z.infer<typeof emailAccountDeleteParamsSchema>;

export const emailAccountConfigBodySchema = z.object({
    emailAddress: z.string().trim().email(),
    providerLabel: z.string().trim().min(1).nullable().optional(),
    imapHost: z.string().trim().min(1),
    imapPort: z.number().int().positive(),
    imapSecure: z.boolean().default(true),
    imapUsername: z.string().trim().min(1),
    imapPassword: z.string().min(1),
    smtpHost: z.string().trim().min(1),
    smtpPort: z.number().int().positive(),
    smtpSecure: z.boolean().default(true),
    smtpUsername: z.string().trim().min(1),
    smtpPassword: z.string().min(1),
});
export type EmailAccountConfigBody = z.infer<typeof emailAccountConfigBodySchema>;

export const emailAccountSummarySchema = z.object({
    id: z.string().uuid(),
    emailAddress: z.string(),
    providerLabel: z.string().nullable(),
    imapHost: z.string(),
    smtpHost: z.string(),
    status: z.enum(['active', 'error', 'disabled']),
    lastValidatedAt: z.string().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
});
export type EmailAccountSummaryOutput = z.infer<typeof emailAccountSummarySchema>;

export const listEmailAccountsResponseSchema = z.object({
    accounts: z.array(emailAccountSummarySchema),
    maxMailboxes: z.number().int().nullable(),
});
export type ListEmailAccountsResponse = z.infer<typeof listEmailAccountsResponseSchema>;

export const createEmailAccountResponseSchema = z.object({
    message: z.string(),
    account: emailAccountSummarySchema,
});
