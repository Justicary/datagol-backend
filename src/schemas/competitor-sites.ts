import { z } from 'zod';

/**
 * Esquemas Zod de `routes/organization-competitor-sites.ts`. Estilo de
 * `src/schemas/organization-onboarding.ts`.
 */
export const competitorSiteBodySchema = z.object({
    url: z
        .string()
        .url('Debe ser una URL válida')
        .refine((u) => u.startsWith('http://') || u.startsWith('https://'), 'La URL debe usar http:// o https://'),
    label: z.string().max(100).nullable().optional(),
});
export type CompetitorSiteBody = z.infer<typeof competitorSiteBodySchema>;

export const competitorSiteUpdateSchema = z.object({
    enabled: z.boolean().optional(),
    label: z.string().max(100).nullable().optional(),
});
export type CompetitorSiteUpdateBody = z.infer<typeof competitorSiteUpdateSchema>;

export const competitorSiteParamSchema = z.object({
    id: z.string().uuid('El parámetro id debe ser un UUID válido'),
    siteId: z.string().uuid('El parámetro siteId debe ser un UUID válido'),
});
