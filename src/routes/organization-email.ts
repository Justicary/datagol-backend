import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
    requireAuthenticatedUser,
    requireOrganizationMembership,
    requireOrganizationRole,
} from '../lib/organization-auth.js';
import {
    emailPreviewQuerySchema,
    emailTestBodySchema,
    emailPreviewResponseSchema,
    emailTestResponseSchema,
} from '../schemas/email.js';
import {
    EMAIL_TEMPLATES,
    EMAIL_TYPES,
    type EmailTypeId,
    type CallSummaryEmailData,
    type HotLeadEmailData,
    type AppointmentConfirmationEmailData,
    type ProspectSummaryEmailData,
    type CreditsAlertEmailData,
    type OrganizationEmailSettings,
} from '../types/email-templates.js';
import { deriveSafeEmailTheme } from '../services/email-theme.js';
import { renderEmail } from '../services/email-renderer.js';
import { getResendClient, getFromEmail } from '../services/email.js';

interface OrganizationParams {
    id: string;
}

// Control de tasa en memoria para envíos de prueba: máximo 5 envíos en 15 minutos por organización
const TEST_EMAIL_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TEST_EMAILS_PER_WINDOW = 5;
const testEmailTimestamps = new Map<string, number[]>();

export function checkAndIncrementTestEmailRateLimit(organizationId: string): boolean {
    const now = Date.now();
    const timestamps = testEmailTimestamps.get(organizationId) || [];
    const recent = timestamps.filter((t) => now - t < TEST_EMAIL_RATE_LIMIT_WINDOW_MS);

    if (recent.length >= MAX_TEST_EMAILS_PER_WINDOW) {
        return false;
    }

    recent.push(now);
    testEmailTimestamps.set(organizationId, recent);
    return true;
}

export function clearTestEmailRateLimits(): void {
    testEmailTimestamps.clear();
}

/**
 * Genera datos mock con valores ficticios evidentes para la previsualización y pruebas.
 * NUNCA utiliza datos reales ni PII.
 */
export function getMockEmailData(type: EmailTypeId, organizationName: string): unknown {
    switch (type) {
        case EMAIL_TYPES.CALL_SUMMARY:
            return {
                callerPhone: '+52 55 1234 5678',
                summary: 'El prospecto llamó interesado en la automatización de citas y solicitó información sobre paquetes mensuales.',
                sentiment: 'positivo',
                durationSeconds: 185,
                transcript: 'Cliente: Hola, me gustaría conocer cómo funciona su servicio.\nAgente: ¡Hola! Con gusto te explico los beneficios de nuestra solución omnicanal.',
                nextSteps: ['Enviar propuesta comercial en PDF', 'Llamar para agendar demostración en vivo'],
                businessName: organizationName,
            } satisfies CallSummaryEmailData;

        case EMAIL_TYPES.HOT_LEAD:
            return {
                leadName: 'Juan Pérez',
                leadPhone: '+52 55 9876 5432',
                businessName: organizationName,
                inquiryReason: 'Cotización urgente para servicio corporativo de alta demanda.',
                followupNotes: 'Mencionó que toma la decisión esta semana y solicitó contacto inmediato.',
            } satisfies HotLeadEmailData;

        case EMAIL_TYPES.APPOINTMENT_CONFIRMATION:
            return {
                customerName: 'Juan Pérez',
                customerPhone: '+52 55 9876 5432',
                customerEmail: 'juan.perez@ejemplo.com',
                startTime: 'Martes 25 de Agosto, 11:00 AM',
                businessName: organizationName,
                serviceAddress: 'Av. Paseo de la Reforma 222, Piso 8, CDMX',
                notes: 'Sesión de demostración técnica y configuración inicial.',
            } satisfies AppointmentConfirmationEmailData;

        case EMAIL_TYPES.PROSPECT_SUMMARY:
            return {
                prospectName: 'Juan Pérez',
                businessName: organizationName,
                summary: 'Revisamos las dudas principales sobre los horarios de atención y el flujo de llamadas de tu negocio.',
                followupNotes: 'Quedamos en enviarte la lista de requerimientos técnicos para iniciar tu prueba.',
            } satisfies ProspectSummaryEmailData;

        case EMAIL_TYPES.CREDITS_ALERT:
            return {
                organizationName,
                remainingPercentage: 10,
                threshold: 10,
            } satisfies CreditsAlertEmailData;

        default:
            return { businessName: organizationName };
    }
}

/**
 * Plugin de Fastify para los endpoints de previsualización y prueba de plantillas de correo.
 */
export async function organizationEmailRoutes(fastify: FastifyInstance) {
    async function authorizeAdmin(
        request: FastifyRequest<{ Params: OrganizationParams }>,
        reply: FastifyReply
    ): Promise<{ userId: string; jwt: string; organizationId: string } | null> {
        const { id } = request.params;
        if (!id || typeof id !== 'string' || id.trim() === '') {
            reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" es obligatorio.' });
            return null;
        }

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const isMember = await requireOrganizationMembership(fastify, auth.jwt, id);
        if (!isMember) {
            reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
            return null;
        }

        const isAuthorizedRole = await requireOrganizationRole(fastify, auth.jwt, id, auth.userId, ['owner', 'admin']);
        if (!isAuthorizedRole) {
            reply.status(403).send({ success: false, error: 'Se requiere rol admin u owner para gestionar el correo de la organización.' });
            return null;
        }

        return { userId: auth.userId, jwt: auth.jwt, organizationId: id };
    }

    /**
     * Handler compartido para la previsualización de correos.
     */
    async function handlePreview(request: FastifyRequest<{ Params: OrganizationParams }>, reply: FastifyReply) {
        const ctx = await authorizeAdmin(request, reply);
        if (!ctx) return;

        const queryResult = emailPreviewQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'Parámetros de consulta inválidos: template o type inválidos.',
                details: queryResult.error.format(),
            });
        }

        const { template, type } = queryResult.data;

        const { data: org, error: orgError } = await fastify.supabaseAdmin
            .from('organizations')
            .select('name, integration_settings')
            .eq('id', ctx.organizationId)
            .maybeSingle();

        if (orgError || !org) {
            return reply.status(404).send({ success: false, error: 'Organización no encontrada.' });
        }

        const settings = (org.integration_settings as Record<string, unknown> | null) ?? {};
        const safeTheme = deriveSafeEmailTheme(settings.theme);
        const emailConfig = (settings.email as OrganizationEmailSettings | undefined) ?? {};

        const effectiveTemplate = template || emailConfig.template || EMAIL_TEMPLATES.PROFESIONAL;
        const mockData = getMockEmailData(type, org.name || 'Datagol');

        const rendered = renderEmail(type, mockData, {
            templateId: effectiveTemplate,
            theme: safeTheme,
            logoUrl: emailConfig.logoUrl ?? null,
            footerText: emailConfig.footerText ?? null,
            replyTo: emailConfig.replyTo ?? null,
        });

        // Si el cliente pide explícitamente HTML (ej. vista en iframe o navegador directo)
        const acceptHeader = request.headers.accept || '';
        if (acceptHeader.includes('text/html') && !acceptHeader.includes('application/json')) {
            return reply.type('text/html; charset=utf-8').status(200).send(rendered.html);
        }

        return reply.status(200).send(
            emailPreviewResponseSchema.parse({
                success: true,
                data: {
                    template: rendered.templateId,
                    type: rendered.type,
                    subject: rendered.subject,
                    html: rendered.html,
                    text: rendered.text,
                },
            })
        );
    }

    /**
     * Handler compartido para el envío de prueba de correos.
     */
    async function handleTestSend(request: FastifyRequest<{ Params: OrganizationParams }>, reply: FastifyReply) {
        const ctx = await authorizeAdmin(request, reply);
        if (!ctx) return;

        const bodyResult = emailTestBodySchema.safeParse(request.body || {});
        if (!bodyResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'Cuerpo de la petición inválido.',
                details: bodyResult.error.format(),
            });
        }

        const { template, type, to: customTo } = bodyResult.data;

        // Verificar límite de tasa
        if (!checkAndIncrementTestEmailRateLimit(ctx.organizationId)) {
            return reply.status(429).send({
                success: false,
                error: 'Límite de envíos de prueba excedido (máximo 5 cada 15 minutos). Intenta más tarde.',
            });
        }

        // Obtener la dirección de destino: si viene customTo se usa, si no, se consulta el correo del usuario autenticado
        let targetRecipient = customTo;
        if (!targetRecipient) {
            const { data: userData, error: userError } = await fastify.supabaseAdmin.auth.admin.getUserById(ctx.userId);
            if (userError || !userData?.user?.email) {
                return reply.status(400).send({
                    success: false,
                    error: 'No se pudo resolver la dirección de correo del usuario autenticado para enviar la prueba.',
                });
            }
            targetRecipient = userData.user.email;
        }

        const { data: org, error: orgError } = await fastify.supabaseAdmin
            .from('organizations')
            .select('name, integration_settings')
            .eq('id', ctx.organizationId)
            .maybeSingle();

        if (orgError || !org) {
            return reply.status(404).send({ success: false, error: 'Organización no encontrada.' });
        }

        const settings = (org.integration_settings as Record<string, unknown> | null) ?? {};
        const safeTheme = deriveSafeEmailTheme(settings.theme);
        const emailConfig = (settings.email as OrganizationEmailSettings | undefined) ?? {};

        const effectiveTemplate = template || emailConfig.template || EMAIL_TEMPLATES.PROFESIONAL;
        const mockData = getMockEmailData(type, org.name || 'Datagol');

        const rendered = renderEmail(type, mockData, {
            templateId: effectiveTemplate,
            theme: safeTheme,
            logoUrl: emailConfig.logoUrl ?? null,
            footerText: emailConfig.footerText ?? null,
            replyTo: emailConfig.replyTo ?? null,
        });

        const resend = getResendClient();
        if (!resend) {
            request.log.warn({ organizationId: ctx.organizationId, msg: 'RESEND_API_KEY no configurada al enviar prueba de correo' });
            return reply.status(503).send({
                success: false,
                error: 'El servicio de correo no está configurado (RESEND_API_KEY ausente en el servidor).',
            });
        }

        try {
            const fromEmail = getFromEmail();
            const emailResponse = await resend.emails.send({
                from: fromEmail,
                to: targetRecipient,
                subject: `[PRUEBA] ${rendered.subject}`,
                html: rendered.html,
                text: rendered.text,
                ...(emailConfig.replyTo ? { replyTo: emailConfig.replyTo } : {}),
            });

            return reply.status(200).send(
                emailTestResponseSchema.parse({
                    success: true,
                    message: `Correo de prueba enviado exitosamente a ${targetRecipient}`,
                    data: {
                        template: rendered.templateId,
                        type: rendered.type,
                        recipient: targetRecipient,
                        emailId: emailResponse.data?.id,
                    },
                })
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            request.log.error({ err, msg, organizationId: ctx.organizationId }, 'Error enviando correo de prueba con Resend');
            return reply.status(500).send({
                success: false,
                error: `Error al enviar correo con Resend: ${msg}`,
            });
        }
    }

    // Registro de rutas con prefijo `/api/organizations/:id/email/*` y alias `/organizations/:id/email/*`
    fastify.get<{ Params: OrganizationParams }>('/api/organizations/:id/email/preview', handlePreview);
    fastify.get<{ Params: OrganizationParams }>('/organizations/:id/email/preview', handlePreview);

    fastify.post<{ Params: OrganizationParams }>('/api/organizations/:id/email/test', handleTestSend);
    fastify.post<{ Params: OrganizationParams }>('/organizations/:id/email/test', handleTestSend);
}

export default organizationEmailRoutes;
