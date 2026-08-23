import { z } from 'zod';

/**
 * Esquemas Zod de `routes/organization-onboarding.ts`. Estilo de
 * `src/schemas/tool-routes.ts`: un schema de body/response por endpoint,
 * validado explícitamente en el handler — no el patrón sin Zod de
 * `routes/organization.ts` (legacy) que este conjunto de endpoints reemplaza.
 */
export const organizationIdParamsSchema = z.object({
    id: z.string().uuid(),
});
export type OrganizationIdParams = z.infer<typeof organizationIdParamsSchema>;

export const createOrganizationBodySchema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    phone_number: z.string().min(1).optional(),
});
export type CreateOrganizationBody = z.infer<typeof createOrganizationBodySchema>;

export const createOrganizationResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        id: z.string(),
        name: z.string(),
        email: z.string(),
    }),
});

// Set construido una sola vez a nivel de módulo — Intl.supportedValuesOf
// recorre internamente la base de datos de zonas horarias de ICU en cada
// llamada; no hay motivo para pagar ese costo en cada validación de body.
const IANA_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

export const businessInfoBodySchema = z.object({
    name: z.string().min(1).optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postal_code: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    business_hours: z.record(z.string(), z.unknown()).optional(),
    // A.1 de docs/tasks/reportes-semanales.md: el scheduler de reportes
    // (Fase B) filtra organizaciones por hora local en SQL, así que necesita
    // esta columna persistida aunque Cal.com también reporte timezone por su
    // propia API — control manual del admin mientras no exista una
    // sincronización automática confiable.
    timezone: z
        .string()
        .refine((tz) => IANA_TIMEZONES.has(tz), { message: 'La zona horaria debe ser un identificador IANA válido (ej. "America/Mexico_City").' })
        .optional(),
});
export type BusinessInfoBody = z.infer<typeof businessInfoBodySchema>;

export const planBodySchema = z.object({
    plan_key: z.string().min(1),
    reason: z.string().min(1),
});
export type PlanBody = z.infer<typeof planBodySchema>;

export const CREDENTIAL_PROVIDERS = ['elevenlabs', 'telnyx', 'meta', 'cal', 'google_maps', 'llm'] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

export const credentialsBodySchema = z.object({
    provider: z.enum(CREDENTIAL_PROVIDERS),
    value: z.string().min(1),
});
export type CredentialsBody = z.infer<typeof credentialsBodySchema>;

export const credentialsStatusResponseSchema = z.object({
    success: z.literal(true),
    data: z.record(
        z.string(),
        z.object({
            present: z.boolean(),
            rotatedAt: z.string().nullable(),
        })
    ),
    // FASE B.2 (grupos de credenciales): en grupo de uno, isOwner siempre es
    // true y managedByOrganizationName siempre null — comportamiento idéntico
    // al de antes de que existieran los grupos. En un grupo compartido real,
    // un miembro no-owner ve las llaves en solo lectura con el nombre de
    // quién las administra.
    isOwner: z.boolean(),
    managedByOrganizationName: z.string().nullable(),
});

export const tokensResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        webhookToken: z.string(),
        webhookSigningSecret: z.string(),
        toolWebhookSecret: z.string(),
    }),
});

const MISSING_TOKEN_KEYS = ['webhook_token', 'webhook_signing_secret', 'tool_webhook_secret'] as const;

export const readinessResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        ready: z.boolean(),
        planKey: z.string().nullable(),
        missingTokens: z.array(z.enum(MISSING_TOKEN_KEYS)),
        missingCredentials: z.array(
            z.object({
                feature: z.string(),
                provider: z.string(),
                missingSecret: z.string(),
            })
        ),
        agentReprovisionPending: z.boolean(),
    }),
});
