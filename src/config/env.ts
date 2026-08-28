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
    // URL pública de ESTE backend (docs/tasks/waitlist_confirmacion_masiva.md,
    // Tarea B3/endpoint público de confirmación) — a diferencia de
    // FRONTEND_APP_URL, aquí el enlace de un clic del WhatsApp de oferta de
    // lista de espera apunta al propio datagol-backend
    // (src/routes/public/waitlist-confirmation.ts), no al dashboard.
    // Opcional a propósito: si falta, waitlist-engine.ts no puede construir
    // un enlace válido y se degrada directamente a la llamada de voz de
    // respaldo en vez de enviar un link roto.
    BACKEND_WEBHOOK_URL: z.string().url('BACKEND_WEBHOOK_URL debe ser una URL válida.').optional(),

    // Plano de control (docs/tasks/control-plane-backend-datagol.md). El mismo
    // repositorio produce dos comportamientos según esta bandera: solo
    // `true` en api.datagol.net. Ver Fase F — con la bandera apagada,
    // ninguna ruta /control/** se registra y no se exige ninguna de las
    // variables de abajo.
    CONTROL_PLANE: z
        .string()
        .default('false')
        .transform((val) => val === 'true'),

    // Llaves privadas de firma de licencias — SOLO en api.datagol.net. JSON
    // `{ "<key_version>": "<pem privada Ed25519>" }`. Validada más abajo
    // (falla rápido si CONTROL_PLANE=true y falta) en vez de con un
    // `.refine()` sobre el objeto completo, para poder dar un mensaje
    // dirigido a esta variable en particular.
    CONTROL_PLANE_SIGNING_KEYS: z.string().optional(),

    // Llaves públicas de verificación de licencia — en TODAS las
    // instalaciones (incluida la propia instancia operativa de Datagol).
    // JSON `{ "<key_version>": "<pem pública Ed25519>" }`. Varias entradas
    // conviven durante una rotación de llave.
    LICENSE_PUBLIC_KEYS: z.string().optional(),

    // URL del plano de control al que esta instalación envía su latido
    // diario (Fase B.2). Ausente en desarrollo local: el job de latido se
    // degrada a reintentar sin bloquear nada (nunca apaga la voz).
    CONTROL_PLANE_URL: z.string().url('CONTROL_PLANE_URL debe ser una URL válida.').optional(),

    // Pasaporte de superadmin — SSO delegado a api.datagol.net para /admin
    // en instalaciones cliente. Mismo criterio de llaves versionadas que las
    // de licencia, pero deliberadamente separadas: comprometer una no debe
    // dar acceso por la otra. Llave privada SOLO en api.datagol.net.
    ADMIN_PASSPORT_SIGNING_KEYS: z.string().optional(),
    // Llave pública de verificación del pase — en TODAS las instalaciones.
    ADMIN_PASSPORT_PUBLIC_KEYS: z.string().optional(),
    // Secreto simétrico de la sesión local post-pase (lib/admin-session.ts)
    // — propio y distinto por instalación, nunca sale de ahí. Opcional a
    // propósito: sin él, /api/admin/sso/exchange simplemente no funciona en
    // esa instalación (no es una ruta crítica de voz).
    ADMIN_SESSION_SECRET: z.string().optional(),
    // Identificador de ESTA instalación = deployments.id en el plano de
    // control — es el `aud` que un pase debe traer para ser válido aquí.
    // Se fija al aprovisionar (Fase C); en instalaciones ya desplegadas hay
    // que agregarlo a mano para que el SSO empiece a funcionar ahí.
    DEPLOYMENT_ID: z.string().uuid('DEPLOYMENT_ID debe ser un UUID válido.').optional(),
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

    // Fase F — "si la bandera está encendida pero faltan las llaves de
    // firma, la aplicación falla de inmediato con mensaje claro". No se
    // valida con Zod arriba porque el mensaje debe ser específico a esta
    // combinación, no un error genérico de "campo opcional inválido".
    if (result.data.CONTROL_PLANE) {
        const missing: string[] = [];
        if (!result.data.CONTROL_PLANE_SIGNING_KEYS) missing.push('CONTROL_PLANE_SIGNING_KEYS');
        if (!result.data.LICENSE_PUBLIC_KEYS) missing.push('LICENSE_PUBLIC_KEYS');
        if (!result.data.ADMIN_PASSPORT_SIGNING_KEYS) missing.push('ADMIN_PASSPORT_SIGNING_KEYS');

        if (missing.length > 0) {
            const message = `Error fatal: CONTROL_PLANE=true pero faltan las variables de firma de licencia: ${missing.join(', ')}. Esta instalación es el plano de control y no puede arrancar sin sus llaves.`;
            logger.error({ missing }, '[Env] CONTROL_PLANE activo sin llaves de firma configuradas');
            throw new Error(message);
        }
    }

    cachedEnv = result.data;
    return cachedEnv;
}
