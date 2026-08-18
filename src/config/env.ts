import { z } from 'zod';
import dotenv from 'dotenv';
import { logger } from '../lib/logger.js';

dotenv.config();

const envSchema = z.object({
    PORT: z.string().default('3000').transform((val) => parseInt(val, 10)),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string({
        message: 'La variable DATABASE_URL es obligatoria para la conexión a Postgres/pg-boss.',
    }).min(1),
    SUPABASE_URL: z.string({
        message: 'La variable SUPABASE_URL es obligatoria.',
    }).url('SUPABASE_URL debe ser una URL válida.'),
    SUPABASE_SECRET_KEY: z.string({
        message: 'La variable SUPABASE_SECRET_KEY es obligatoria para el cliente de servicio.',
    }).min(1),
    SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    CAL_API_KEY: z.string().optional(),
    DEFAULT_VOICE_PROVIDER: z.string().default('elevenlabs'),
    ELEVENLABS_API_KEY: z.string().optional(),
    ELEVENLABS_AGENT_ID: z.string().optional(),
    ELEVENLABS_WEBHOOK_SECRET: z.string().optional(),
    ELEVENLABS_PHONE_NUMBER_ID: z.string().optional(),
    TELNYX_API_KEY: z.string().optional(),
    TELNYX_PUBLIC_KEY: z.string().optional(),
    TELNYX_PHONE_NUMBER: z.string().optional(),
    TELNYX_SIP_CONNECTION_ID: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),
    RESEND_FROM_EMAIL: z.string().optional(),
    // Sin precedente de URL de frontend en este backend antes de
    // docs/tasks/asistencia-valor de cierre.md (B.3) — opcional a propósito:
    // si no está configurada, el correo de recordatorio omite el enlace
    // directo en vez de inventar un dominio.
    FRONTEND_APP_URL: z.string().url('FRONTEND_APP_URL debe ser una URL válida.').optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

let cachedEnv: EnvConfig | null = null;

/**
 * Valida las variables de entorno del proceso.
 * Falla de inmediato con una excepción clara si falta alguna variable crítica.
 */
export function validateEnv(): EnvConfig {
    if (cachedEnv) return cachedEnv;

    const result = envSchema.safeParse(process.env);

    if (!result.success) {
        const issues = result.error.issues || [];
        const formattedErrors = issues
            .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
            .join('\n');
        const errorMessage = `Error fatal al validar las variables de entorno:\n${formattedErrors}`;
        logger.error({ errors: formattedErrors }, '[Env] Error fatal al validar variables de entorno');
        throw new Error(errorMessage);
    }

    cachedEnv = result.data;
    return cachedEnv;
}
