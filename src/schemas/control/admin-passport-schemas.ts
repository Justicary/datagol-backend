import { z } from 'zod';

export const issueAdminPassportBodySchema = z
    .object({
        deploymentId: z.string().uuid('deploymentId debe ser un UUID válido.'),
    })
    .strict();
