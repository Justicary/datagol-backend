import { z } from 'zod';

/**
 * Esquemas Zod de `GET /api/admin/email-accounts/organization/:orgId/inbox-summary`
 * (docs/tasks/email-inbox-summary-backend.md). Los parámetros de ruta
 * reutilizan `emailAccountOrgParamsSchema` de `schemas/email-account.ts` — no
 * se duplican aquí.
 */

export const emailInboxSummaryTaskSchema = z.object({
    id: z.string(),
    uid: z.number().int().optional(),
    from: z.string().nullable().optional(),
    fromName: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    subject: z.string().nullable(),
    date: z.string().nullable(),
    snippet: z.string(),
    unread: z.boolean(),
    category: z.enum(['unread', 'draft', 'error']),
});
export type EmailInboxSummaryTask = z.infer<typeof emailInboxSummaryTaskSchema>;

export const emailInboxSummaryStatsSchema = z.object({
    unreadCount: z.number().int().nonnegative(),
    draftsCount: z.number().int().nonnegative(),
    errorsCount: z.number().int().nonnegative(),
    sentCount: z.number().int().nonnegative(),
});
export type EmailInboxSummaryStats = z.infer<typeof emailInboxSummaryStatsSchema>;

export const emailInboxSummaryResponseSchema = z.object({
    unreadCount: z.number().int().nonnegative(),
    draftsCount: z.number().int().nonnegative(),
    errorsCount: z.number().int().nonnegative(),
    sentCount: z.number().int().nonnegative(),
    totalMessages: z.number().int().nonnegative(),
    lastSyncedAt: z.string().nullable(),
    stats: emailInboxSummaryStatsSchema,
    messages: z.array(emailInboxSummaryTaskSchema),
});
export type EmailInboxSummaryResponse = z.infer<typeof emailInboxSummaryResponseSchema>;
