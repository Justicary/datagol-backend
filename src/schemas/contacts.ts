import { z } from 'zod';

/**
 * Esquemas Zod de `routes/contacts.ts`. Mismo estilo que
 * `src/schemas/organization-onboarding.ts`.
 */
export const contactErasureParamsSchema = z.object({
    id: z.string().uuid(),
    contactId: z.string().uuid(),
});
export type ContactErasureParams = z.infer<typeof contactErasureParamsSchema>;

export const contactErasureResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        contactId: z.string(),
        erasedAt: z.string(),
    }),
});
