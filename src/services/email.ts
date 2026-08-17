import { Resend } from 'resend';
import dotenv from 'dotenv';
import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabase.js';
import {
    EMAIL_TYPES,
    EMAIL_TEMPLATES,
    type EmailTemplateId,
    type CallSummaryEmailData,
    type HotLeadEmailData,
    type AppointmentConfirmationEmailData,
    type ProspectSummaryEmailData,
    type CreditsAlertEmailData,
    type OrganizationEmailSettings,
} from '../types/email-templates.js';
import { deriveSafeEmailTheme, DEFAULT_DATAGOL_EMAIL_THEME } from './email-theme.js';
import { renderEmail, type EmailRenderOptions } from './email-renderer.js';

dotenv.config();

let resendClient: Resend | null = null;

export function getResendClient(): Resend | null {
    if (!resendClient) {
        const apiKey = process.env.RESEND_API_KEY;
        if (!apiKey || apiKey.trim() === '') {
            logger.warn('[Email] RESEND_API_KEY no está configurada. El servicio de correo estará deshabilitado.');
            return null;
        }
        resendClient = new Resend(apiKey);
    }
    return resendClient;
}

export function setResendClientForTesting(client: Resend | null): void {
    resendClient = client;
}

export function getFromEmail(): string {
    return process.env.RESEND_FROM_EMAIL || 'Datagol Agentes <info@ia.datagol.net>';
}

/**
 * Consulta y normaliza las opciones de tema y plantilla de una organización.
 */
export async function resolveOrganizationEmailOptions(organizationId?: string | null): Promise<EmailRenderOptions> {
    if (!organizationId) {
        return {
            templateId: EMAIL_TEMPLATES.PROFESIONAL,
            theme: DEFAULT_DATAGOL_EMAIL_THEME,
        };
    }

    try {
        const { data: org, error } = await supabaseAdmin
            .from('organizations')
            .select('name, integration_settings')
            .eq('id', organizationId)
            .maybeSingle();

        if (error || !org) {
            return {
                templateId: EMAIL_TEMPLATES.PROFESIONAL,
                theme: DEFAULT_DATAGOL_EMAIL_THEME,
            };
        }

        const settings = (org.integration_settings as Record<string, unknown> | null) ?? {};
        const safeTheme = deriveSafeEmailTheme(settings.theme);
        const emailConfig = (settings.email as OrganizationEmailSettings | undefined) ?? {};

        return {
            templateId: emailConfig.template || EMAIL_TEMPLATES.PROFESIONAL,
            theme: safeTheme,
            logoUrl: emailConfig.logoUrl ?? null,
            footerText: emailConfig.footerText ?? null,
            replyTo: emailConfig.replyTo ?? null,
        };
    } catch (err) {
        logger.warn({ err, organizationId }, '[Email] No se pudieron cargar los ajustes de email de la organización, usando defaults');
        return {
            templateId: EMAIL_TEMPLATES.PROFESIONAL,
            theme: DEFAULT_DATAGOL_EMAIL_THEME,
        };
    }
}

/**
 * Parámetros comunes de envío.
 */
export interface BaseEmailSendParams {
    to: string;
    organizationId?: string | null;
    templateId?: EmailTemplateId | string | null;
    customOptions?: Partial<EmailRenderOptions>;
}

export interface SendCallSummaryEmailParams extends BaseEmailSendParams {
    callerPhone?: string;
    summary: string;
    sentiment?: string;
    durationSeconds?: number;
    transcript?: string;
    nextSteps?: string[];
    businessName?: string;
}

/**
 * Envía la minuta ejecutiva de una llamada con plantilla seleccionable y diseño en tablas responsivo.
 */
export async function sendCallSummaryEmail(params: SendCallSummaryEmailParams) {
    const resend = getResendClient();
    if (!resend) {
        logger.warn('[Email] Omitiendo envío de correo por falta de RESEND_API_KEY.');
        return null;
    }

    const {
        to,
        callerPhone = 'No especificado',
        summary,
        sentiment = 'neutral',
        durationSeconds = 0,
        transcript = 'Sin transcripción disponible',
        nextSteps = [],
        businessName,
        organizationId,
        templateId,
        customOptions,
    } = params;

    const baseOptions = await resolveOrganizationEmailOptions(organizationId);
    const renderOptions: EmailRenderOptions = {
        ...baseOptions,
        ...(templateId ? { templateId } : {}),
        ...(customOptions ?? {}),
    };

    const callSummaryData: CallSummaryEmailData = {
        callerPhone,
        summary,
        sentiment,
        durationSeconds,
        transcript,
        nextSteps,
        businessName,
    };

    const rendered = renderEmail(EMAIL_TYPES.CALL_SUMMARY, callSummaryData, renderOptions);

    try {
        const fromEmail = getFromEmail();
        const response = await resend.emails.send({
            from: fromEmail,
            to,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            ...(renderOptions.replyTo ? { replyTo: renderOptions.replyTo } : {}),
        });

        if (response.error) {
            logger.error({ error: response.error, to }, '[Email] Resend respondió con error al enviar resumen de llamada');
            return null;
        }

        logger.info({ to, emailId: response.data?.id }, '[Email] Correo de resumen de llamada enviado');
        return response;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, msg }, '[Email] Error al enviar el correo con Resend');
        return null;
    }
}

export interface SendHotLeadAlertEmailParams extends BaseEmailSendParams {
    leadName?: string | null;
    leadPhone?: string | null;
    businessName?: string | null;
    inquiryReason?: string | null;
    followupNotes?: string | null;
}

/**
 * Alerta urgente de prospecto caliente sin cita agendada.
 */
export async function sendHotLeadAlertEmail(params: SendHotLeadAlertEmailParams) {
    const resend = getResendClient();
    if (!resend) {
        logger.warn('[Email] Omitiendo alerta de prospecto caliente por falta de RESEND_API_KEY.');
        return null;
    }

    const {
        to,
        leadName = 'Prospecto sin nombre registrado',
        leadPhone = 'No especificado',
        businessName = 'tu negocio',
        inquiryReason = 'No especificado',
        followupNotes = null,
        organizationId,
        templateId,
        customOptions,
    } = params;

    const baseOptions = await resolveOrganizationEmailOptions(organizationId);
    const renderOptions: EmailRenderOptions = {
        ...baseOptions,
        ...(templateId ? { templateId } : {}),
        ...(customOptions ?? {}),
    };

    const hotLeadData: HotLeadEmailData = {
        leadName,
        leadPhone,
        businessName,
        inquiryReason,
        followupNotes,
    };

    const rendered = renderEmail(EMAIL_TYPES.HOT_LEAD, hotLeadData, renderOptions);

    try {
        const fromEmail = getFromEmail();
        const response = await resend.emails.send({
            from: fromEmail,
            to,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            ...(renderOptions.replyTo ? { replyTo: renderOptions.replyTo } : {}),
        });

        if (response.error) {
            logger.error({ error: response.error, to }, '[Email] Resend respondió con error al enviar alerta de prospecto caliente');
            return null;
        }

        logger.info({ to, emailId: response.data?.id }, '[Email] Alerta de prospecto caliente enviada');
        return response;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, msg }, '[Email] Error al enviar la alerta de prospecto caliente con Resend');
        return null;
    }
}

export interface SendProspectSummaryEmailParams extends BaseEmailSendParams {
    prospectName?: string | null;
    businessName?: string | null;
    summary?: string | null;
    followupNotes?: string | null;
}

/**
 * Resumen de cortesía enviado al propio prospecto (no al negocio).
 */
export async function sendProspectSummaryEmail(params: SendProspectSummaryEmailParams) {
    const resend = getResendClient();
    if (!resend) {
        logger.warn('[Email] Omitiendo resumen al prospecto por falta de RESEND_API_KEY.');
        return null;
    }

    const {
        to,
        prospectName = 'Estimado cliente',
        businessName = 'nuestro equipo',
        summary = 'Gracias por tu llamada. Nos pondremos en contacto contigo pronto.',
        followupNotes = null,
        organizationId,
        templateId,
        customOptions,
    } = params;

    const baseOptions = await resolveOrganizationEmailOptions(organizationId);
    const renderOptions: EmailRenderOptions = {
        ...baseOptions,
        ...(templateId ? { templateId } : {}),
        ...(customOptions ?? {}),
    };

    const prospectSummaryData: ProspectSummaryEmailData = {
        prospectName,
        businessName,
        summary,
        followupNotes,
    };

    const rendered = renderEmail(EMAIL_TYPES.PROSPECT_SUMMARY, prospectSummaryData, renderOptions);

    try {
        const fromEmail = getFromEmail();
        const response = await resend.emails.send({
            from: fromEmail,
            to,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            ...(renderOptions.replyTo ? { replyTo: renderOptions.replyTo } : {}),
        });

        if (response.error) {
            logger.error({ error: response.error, to }, '[Email] Resend respondió con error al enviar resumen al prospecto');
            return null;
        }

        logger.info({ to, emailId: response.data?.id }, '[Email] Resumen al prospecto enviado');
        return response;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, msg }, '[Email] Error al enviar el resumen al prospecto con Resend');
        return null;
    }
}

export interface SendAppointmentConfirmationEmailParams extends BaseEmailSendParams {
    customerName: string;
    customerPhone?: string | null;
    customerEmail?: string | null;
    startTime: string;
    endTime?: string | null;
    businessName?: string | null;
    serviceAddress?: string | null;
    notes?: string | null;
}

/**
 * Confirmación de cita agendada.
 */
export async function sendAppointmentConfirmationEmail(params: SendAppointmentConfirmationEmailParams) {
    const resend = getResendClient();
    if (!resend) {
        logger.warn('[Email] Omitiendo confirmación de cita por falta de RESEND_API_KEY.');
        return null;
    }

    const {
        to,
        customerName,
        customerPhone,
        customerEmail,
        startTime,
        endTime,
        businessName,
        serviceAddress,
        notes,
        organizationId,
        templateId,
        customOptions,
    } = params;

    const baseOptions = await resolveOrganizationEmailOptions(organizationId);
    const renderOptions: EmailRenderOptions = {
        ...baseOptions,
        ...(templateId ? { templateId } : {}),
        ...(customOptions ?? {}),
    };

    const appointmentData: AppointmentConfirmationEmailData = {
        customerName,
        customerPhone,
        customerEmail,
        startTime,
        endTime,
        businessName,
        serviceAddress,
        notes,
    };

    const rendered = renderEmail(EMAIL_TYPES.APPOINTMENT_CONFIRMATION, appointmentData, renderOptions);

    try {
        const fromEmail = getFromEmail();
        const response = await resend.emails.send({
            from: fromEmail,
            to,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            ...(renderOptions.replyTo ? { replyTo: renderOptions.replyTo } : {}),
        });

        if (response.error) {
            logger.error({ error: response.error, to }, '[Email] Resend respondió con error al enviar confirmación de cita');
            return null;
        }

        logger.info({ to, emailId: response.data?.id }, '[Email] Confirmación de cita enviada');
        return response;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, msg }, '[Email] Error al enviar confirmación de cita con Resend');
        return null;
    }
}

export interface SendElevenLabsCreditsAlertEmailParams extends BaseEmailSendParams {
    organizationName?: string | null;
    remainingPercentage: number;
    threshold: number;
}

/**
 * Alerta de créditos de ElevenLabs agotándose.
 */
export async function sendElevenLabsCreditsAlertEmail(params: SendElevenLabsCreditsAlertEmailParams) {
    const resend = getResendClient();
    if (!resend) {
        logger.warn('[Email] Omitiendo alerta de créditos de ElevenLabs por falta de RESEND_API_KEY.');
        return null;
    }

    const {
        to,
        organizationName = 'tu organización',
        remainingPercentage,
        threshold,
        organizationId,
        templateId,
        customOptions,
    } = params;

    const baseOptions = await resolveOrganizationEmailOptions(organizationId);
    const renderOptions: EmailRenderOptions = {
        ...baseOptions,
        ...(templateId ? { templateId } : {}),
        ...(customOptions ?? {}),
    };

    const creditsData: CreditsAlertEmailData = {
        organizationName,
        remainingPercentage,
        threshold,
    };

    const rendered = renderEmail(EMAIL_TYPES.CREDITS_ALERT, creditsData, renderOptions);

    try {
        const fromEmail = getFromEmail();
        const response = await resend.emails.send({
            from: fromEmail,
            to,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            ...(renderOptions.replyTo ? { replyTo: renderOptions.replyTo } : {}),
        });

        if (response.error) {
            logger.error({ error: response.error, to, threshold }, '[Email] Resend respondió con error al enviar alerta de créditos');
            return null;
        }

        logger.info({ to, emailId: response.data?.id, threshold }, '[Email] Alerta de créditos de ElevenLabs enviada');
        return response;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, msg, threshold }, '[Email] Error al enviar la alerta de créditos de ElevenLabs con Resend');
        return null;
    }
}
