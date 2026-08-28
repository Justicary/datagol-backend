import { z } from 'zod';

export const issueLicenseBodySchema = z
    .object({
        deploymentId: z.string().uuid('deploymentId debe ser un UUID válido.'),
        validityDays: z.number().int().positive().max(365).optional(),
        warnAfterDays: z.number().int().positive().optional(),
        limitFeaturesAfterDays: z.number().int().positive().optional(),
        lockDashboardAfterDays: z.number().int().positive().optional(),
        fingerprint: z.string().trim().min(1).nullable().optional(),
    })
    .strict();

export const revokeLicenseBodySchema = z
    .object({
        reason: z.string().trim().min(1, 'El motivo de revocación es obligatorio.'),
    })
    .strict();

export const rotateLicenseBodySchema = z
    .object({
        validityDays: z.number().int().positive().max(365).optional(),
    })
    .strict();
