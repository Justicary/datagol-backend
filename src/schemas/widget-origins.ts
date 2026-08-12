import { z } from 'zod';

/**
 * Esquemas Zod de `routes/organization-widget.ts` — gestión, desde el
 * dashboard del tenant, de los orígenes autorizados de su widget de chat
 * web y del tope diario de sesiones. Mismo estilo que
 * `schemas/organization-onboarding.ts`.
 */
export const organizationIdParamsSchema = z.object({
    id: z.string().uuid(),
});
export type OrganizationIdParams = z.infer<typeof organizationIdParamsSchema>;

export const widgetOriginParamsSchema = z.object({
    id: z.string().uuid(),
    originId: z.string().uuid(),
});
export type WidgetOriginParams = z.infer<typeof widgetOriginParamsSchema>;

export const createWidgetOriginBodySchema = z.object({
    origin: z.string().url(),
});
export type CreateWidgetOriginBody = z.infer<typeof createWidgetOriginBodySchema>;

export const updateWidgetOriginBodySchema = z.object({
    enabled: z.boolean(),
});
export type UpdateWidgetOriginBody = z.infer<typeof updateWidgetOriginBodySchema>;

export const widgetOriginSchema = z.object({
    id: z.string().uuid(),
    origin: z.string(),
    publicKey: z.string(),
    enabled: z.boolean(),
    createdAt: z.string(),
});
export type WidgetOrigin = z.infer<typeof widgetOriginSchema>;

export const listWidgetOriginsResponseSchema = z.object({
    success: z.literal(true),
    data: z.array(widgetOriginSchema),
});

export const widgetOriginResponseSchema = z.object({
    success: z.literal(true),
    data: widgetOriginSchema,
});

export const updateWidgetSettingsBodySchema = z.object({
    dailySessionLimit: z.number().int().positive(),
});
export type UpdateWidgetSettingsBody = z.infer<typeof updateWidgetSettingsBodySchema>;

export const widgetSettingsResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        dailySessionLimit: z.number().int(),
    }),
});
