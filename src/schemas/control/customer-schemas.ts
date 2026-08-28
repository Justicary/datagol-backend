import { z } from 'zod';

export const upsertCustomerBodySchema = z
    .object({
        legalName: z.string().trim().min(1, 'legalName es obligatorio.'),
        tradeName: z.string().trim().nullable().optional(),
        rfc: z
            .string()
            .trim()
            .regex(/^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/, 'rfc no tiene un formato válido.')
            .nullable()
            .optional(),
        taxRegime: z.string().trim().nullable().optional(),
        fiscalAddress: z.string().trim().nullable().optional(),
        fiscalCity: z.string().trim().nullable().optional(),
        fiscalState: z.string().trim().nullable().optional(),
        fiscalPostalCode: z.string().trim().nullable().optional(),
        contactName: z.string().trim().min(1, 'contactName es obligatorio.'),
        contactRole: z.string().trim().nullable().optional(),
        contactEmail: z.string().trim().email('contactEmail debe ser un correo válido.'),
        contactPhoneE164: z
            .string()
            .trim()
            .regex(/^\+[1-9][0-9]{7,14}$/, 'contactPhoneE164 debe estar en formato E.164.')
            .nullable()
            .optional(),
        businessSector: z.string().trim().nullable().optional(),
        notes: z.string().trim().nullable().optional(),
    })
    .strict();

export const patchCustomerBodySchema = upsertCustomerBodySchema.partial();

export const DEPLOYMENT_STATUSES = [
    'borrador',
    'contratado',
    'aprovisionando',
    'configurando',
    'activo',
    'suspendido',
    'cancelado',
] as const;

export const upsertDeploymentBodySchema = z
    .object({
        customerId: z.string().uuid('customerId debe ser un UUID válido.'),
        slug: z
            .string()
            .trim()
            .regex(/^[a-z0-9][a-z0-9-]{2,40}$/, 'slug debe ser minúsculas/números/guiones, 3-41 caracteres.'),
        planKey: z.string().trim().min(1, 'planKey es obligatorio.'),
        setupFeeMxn: z.number().nonnegative().nullable().optional(),
        retainerMxn: z.number().nonnegative().nullable().optional(),
        currency: z.enum(['MXN', 'USD']).default('MXN'),
        billingPeriod: z.enum(['mensual', 'anual', 'unico']).default('mensual'),
        installUrl: z.string().trim().url('installUrl debe ser una URL válida.').nullable().optional(),
        installRegion: z.string().trim().nullable().optional(),
    })
    .strict();

export const patchDeploymentBodySchema = upsertDeploymentBodySchema.partial().extend({
    customerId: z.string().uuid().optional(),
});

export const changeDeploymentStatusBodySchema = z
    .object({
        status: z.enum(DEPLOYMENT_STATUSES),
        reason: z.string().trim().nullable().optional(),
    })
    .strict();

export const patchProvisioningTaskBodySchema = z
    .object({
        status: z.enum(['pendiente', 'en_proceso', 'bloqueada', 'completada', 'omitida']),
        blockedReason: z.string().trim().nullable().optional(),
        notes: z.string().trim().nullable().optional(),
    })
    .strict();
