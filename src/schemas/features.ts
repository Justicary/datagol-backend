import { z } from 'zod';
import { ALL_FEATURE_CATEGORIES } from '../types/feature-taxonomy.js';

/**
 * Esquema para la categoría de características.
 * Validado contra los valores canónicos permitidos por el constraint en la base de datos.
 */
export const featureCategorySchema = z.enum(
    ALL_FEATURE_CATEGORIES as unknown as readonly [string, ...string[]]
);

/**
 * Esquema del cuerpo para crear o actualizar (upsert) una característica en el catálogo.
 */
export const upsertFeatureBodySchema = z.object({
    key: z
        .string()
        .min(1, { message: 'El campo "key" no puede estar vacío.' })
        .regex(/^[a-z0-9_]+$/, { message: 'El campo "key" solo puede contener letras minúsculas, números y guiones bajos (snake_case).' })
        .trim(),
    name: z
        .string()
        .min(1, { message: 'El campo "name" no puede estar vacío.' })
        .trim(),
    description: z.string().trim().nullable().optional(),
    category: featureCategorySchema,
    requires_provider: z.string().trim().nullable().optional(),
    has_cost_impact: z.boolean().default(false),
    globally_disabled: z.boolean().default(false).optional(),
    disabled_reason: z.string().trim().nullable().optional(),
    sort_order: z.number().int().min(0, { message: 'El campo "sort_order" debe ser un entero mayor o igual a 0.' }).default(0).optional(),
    plans: z.array(z.string().min(1)).optional(),
});

export type UpsertFeatureBody = z.infer<typeof upsertFeatureBodySchema>;

/**
 * Esquema de salida para una característica en el catálogo administrativo.
 */
export const adminFeatureSchema = z.object({
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    category: z.string(),
    requires_provider: z.string().nullable(),
    has_cost_impact: z.boolean(),
    globally_disabled: z.boolean(),
    disabled_reason: z.string().nullable(),
    sort_order: z.number().int(),
    created_at: z.string(),
    plans: z.array(z.string()),
});

export type AdminFeature = z.infer<typeof adminFeatureSchema>;
