import { z } from 'zod';

/**
 * Esquemas Zod de `routes/organization-metrics.ts`. Mismo estilo que
 * `src/schemas/organization-onboarding.ts` / `src/schemas/contacts.ts`.
 * Ver docs/tasks/opus.md y db/migrations/24_channel_metrics.sql (la función
 * `get_organization_channel_metrics` que respalda esta respuesta).
 */
export const organizationMetricsParamsSchema = z.object({
    id: z.string().uuid(),
});
export type OrganizationMetricsParams = z.infer<typeof organizationMetricsParamsSchema>;

export const organizationMetricsQuerySchema = z.object({
    from: z.string().min(1),
    to: z.string().min(1),
});
export type OrganizationMetricsQuery = z.infer<typeof organizationMetricsQuerySchema>;

const costByCategorySchema = z.array(
    z.object({
        category: z.string(),
        costUsd: z.number(),
        costMxn: z.number().nullable(),
    })
);

const channelMetricsSchema = z.object({
    channel: z.string(),
    conversationsTotal: z.number().int(),
    leadsCaptured: z.number().int(),
    hotLeads: z.number().int(),
    appointmentsBooked: z.number().int(),
    costUsd: z.number(),
    costMxn: z.number().nullable(),
    costByCategory: costByCategorySchema,
    costPerLeadCapturedUsd: z.number().nullable(),
    costPerAppointmentUsd: z.number().nullable(),
    appointmentConversionRate: z.number(),
});

const unattributedUsageSchema = z.object({
    entriesCount: z.number().int(),
    costUsd: z.number(),
    costMxn: z.number().nullable(),
    costByCategory: costByCategorySchema,
});

export const organizationMetricsResponseSchema = z.object({
    organizationId: z.string(),
    periodFrom: z.string(),
    periodTo: z.string(),
    channels: z.array(channelMetricsSchema),
    unattributedUsage: unattributedUsageSchema,
    crossChannelContacts: z.number().int(),
    exchangeRateUsed: z.number().nullable(),
});
export type OrganizationMetricsResponse = z.infer<typeof organizationMetricsResponseSchema>;
