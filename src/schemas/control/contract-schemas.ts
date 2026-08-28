import { z } from 'zod';

export const generateContractBodySchema = z
    .object({
        templateVersion: z.string().trim().min(1, 'templateVersion es obligatorio.'),
        signerName: z.string().trim().min(1, 'signerName es obligatorio.'),
        signerRole: z.string().trim().nullable().optional(),
        signerEmail: z.string().trim().email('signerEmail debe ser un correo válido.'),
        signerPhoneE164: z
            .string()
            .trim()
            .regex(/^\+[1-9][0-9]{7,14}$/, 'signerPhoneE164 debe estar en formato E.164.')
            .nullable()
            .optional(),
    })
    .strict();

export const sendOtpBodySchema = z.object({}).strict();

export const signContractBodySchema = z
    .object({
        code: z
            .string()
            .trim()
            .regex(/^[0-9]{6}$/, 'code debe tener 6 dígitos.'),
        signerIp: z.string().trim().nullable().optional(),
        signerUserAgent: z.string().trim().nullable().optional(),
    })
    .strict();
