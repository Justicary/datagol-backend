import { z } from 'zod';
import { CUSTOM_FIELD_ENTITY_TYPES, CUSTOM_FIELD_TYPES } from '../types/catalog-custom-fields.js';

export const customFieldParamsSchema = z.object({
    id: z.string().uuid('El parámetro id debe ser un UUID válido'),
    catalogId: z.string().uuid('El parámetro catalogId debe ser un UUID válido'),
    fieldId: z.string().uuid('El parámetro fieldId debe ser un UUID válido'),
});

export const customFieldEntityTypeEnum = z.enum([
    CUSTOM_FIELD_ENTITY_TYPES.PRODUCT,
    CUSTOM_FIELD_ENTITY_TYPES.VARIANT,
]);

export const customFieldTypeEnum = z.enum([
    CUSTOM_FIELD_TYPES.TEXT,
    CUSTOM_FIELD_TYPES.NUMBER,
    CUSTOM_FIELD_TYPES.BOOLEAN,
    CUSTOM_FIELD_TYPES.SELECT,
]);

export function slugifyKey(name: string): string {
    return name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

export const createCustomFieldBodySchema = z
    .object({
        entityType: customFieldEntityTypeEnum,
        name: z.string().min(1, 'El nombre del campo es obligatorio').max(100),
        key: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z0-9_]+$/, 'El key debe contener solo letras minúsculas, números y guiones bajos')
            .optional(),
        fieldType: customFieldTypeEnum,
        options: z.array(z.string().min(1)).default([]),
        description: z.string().max(500).nullable().optional(),
        isRequired: z.boolean().default(false),
        includeInRag: z.boolean().default(true),
        orderIndex: z.number().int().default(0),
    })
    .refine(
        (data) => {
            if (data.fieldType === CUSTOM_FIELD_TYPES.SELECT) {
                return Array.isArray(data.options) && data.options.length > 0;
            }
            return true;
        },
        {
            message: 'Los campos de tipo "select" deben incluir al menos una opción en "options"',
            path: ['options'],
        }
    );

export type CreateCustomFieldBody = z.infer<typeof createCustomFieldBodySchema>;

export const updateCustomFieldBodySchema = z
    .object({
        name: z.string().min(1).max(100).optional(),
        fieldType: customFieldTypeEnum.optional(),
        options: z.array(z.string().min(1)).optional(),
        description: z.string().max(500).nullable().optional(),
        isRequired: z.boolean().optional(),
        includeInRag: z.boolean().optional(),
        orderIndex: z.number().int().optional(),
    })
    .refine(
        (data) => {
            if (data.fieldType === CUSTOM_FIELD_TYPES.SELECT && data.options !== undefined) {
                return Array.isArray(data.options) && data.options.length > 0;
            }
            return true;
        },
        {
            message: 'Los campos de tipo "select" deben incluir al menos una opción en "options"',
            path: ['options'],
        }
    );

export type UpdateCustomFieldBody = z.infer<typeof updateCustomFieldBodySchema>;

export const catalogCustomFieldSchema = z.object({
    id: z.string().uuid(),
    catalogId: z.string().uuid(),
    entityType: customFieldEntityTypeEnum,
    name: z.string(),
    key: z.string(),
    fieldType: customFieldTypeEnum,
    options: z.array(z.string()),
    description: z.string().nullable(),
    isRequired: z.boolean(),
    includeInRag: z.boolean(),
    orderIndex: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
});

export const customFieldResponseSchema = z.object({
    success: z.literal(true),
    data: catalogCustomFieldSchema,
});

export const listCustomFieldsResponseSchema = z.object({
    success: z.literal(true),
    data: z.array(catalogCustomFieldSchema),
});
