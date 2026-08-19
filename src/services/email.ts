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
    type ThankYouEmailData,
    type OrganizationEmailSettings,
    type WeeklyReportEmailData,
    type PendingOutcomeReminderEmailData,
} from '../types/email-templates.js';
import type { ReportType } from '../types/reports.js';
import { REPORT_TYPES } from '../types/reports.js';
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

export interface SendThankYouEmailParams extends BaseEmailSendParams {
    prospectName?: string | null;
    businessName?: string | null;
    customSubject?: string | null;
    customBody?: string | null;
    attachmentBuffer?: Buffer | null;
    attachmentFileName?: string | null;
    attachmentDownloadUrl?: string | null;
}

/**
 * Envía correo de agradecimiento automático al prospecto captado.
 */
export async function sendThankYouEmail(params: SendThankYouEmailParams) {
    const resend = getResendClient();
    if (!resend) {
        logger.warn('[Email] Omitiendo agradecimiento por falta de RESEND_API_KEY.');
        return null;
    }

    const {
        to,
        prospectName = 'Estimado cliente',
        businessName = 'nuestro equipo',
        customSubject = null,
        customBody = null,
        attachmentBuffer = null,
        attachmentFileName = null,
        attachmentDownloadUrl = null,
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

    const thankYouData: ThankYouEmailData = {
        prospectName,
        businessName,
        customSubject,
        customBody,
        attachmentDownloadUrl,
        attachmentFileName,
    };

    const rendered = renderEmail(EMAIL_TYPES.THANK_YOU, thankYouData, renderOptions);

    // Si hay buffer de adjunto y su tamaño no excede 7MB, se adjunta directamente al correo
    const emailAttachments =
        attachmentBuffer && attachmentBuffer.length <= 7 * 1024 * 1024
            ? [
                  {
                      filename: attachmentFileName || 'documento.pdf',
                      content: attachmentBuffer,
                  },
              ]
            : undefined;

    try {
        const fromEmail = getFromEmail();
        const response = await resend.emails.send({
            from: fromEmail,
            to,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            ...(emailAttachments ? { attachments: emailAttachments } : {}),
            ...(renderOptions.replyTo ? { replyTo: renderOptions.replyTo } : {}),
        });

        if (response.error) {
            logger.error({ error: response.error, to }, '[Email] Resend respondió con error al enviar agradecimiento');
            return null;
        }

        logger.info({ to, emailId: response.data?.id }, '[Email] Correo de agradecimiento automático enviado');
        return response;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, msg, to }, '[Email] Error al enviar agradecimiento con Resend');
        return null;
    }
}

export interface SendWeeklyReportEmailParams extends BaseEmailSendParams {
    reportType: ReportType;
    data: WeeklyReportEmailData;
}

/**
 * Envía el reporte semanal (planificación o ejecutivo) — mismo motor de
 * plantillas que el resto de los correos, funciona en las 5 plantillas
 * seleccionables (docs/tasks/reportes-semanales.md B.4).
 */
export async function sendWeeklyReportEmail(params: SendWeeklyReportEmailParams) {
    const resend = getResendClient();
    if (!resend) {
        logger.warn('[Email] Omitiendo envío de reporte semanal por falta de RESEND_API_KEY.');
        return null;
    }

    const { to, reportType, data, organizationId, templateId, customOptions } = params;

    const baseOptions = await resolveOrganizationEmailOptions(organizationId);
    const renderOptions: EmailRenderOptions = {
        ...baseOptions,
        ...(templateId ? { templateId } : {}),
        ...(customOptions ?? {}),
    };

    const emailType = reportType === REPORT_TYPES.PLANNING ? EMAIL_TYPES.WEEKLY_PLANNING_REPORT : EMAIL_TYPES.WEEKLY_EXECUTIVE_REPORT;
    const rendered = renderEmail(emailType, data, renderOptions);

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
            logger.error({ error: response.error, to, reportType }, '[Email] Resend respondió con error al enviar reporte semanal');
            return null;
        }

        logger.info({ to, reportType, emailId: response.data?.id }, '[Email] Reporte semanal enviado');
        return response;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, msg, reportType }, '[Email] Error al enviar el reporte semanal con Resend');
        return null;
    }
}

export interface SendPendingOutcomeReminderEmailParams extends BaseEmailSendParams {
    data: PendingOutcomeReminderEmailData;
}

/**
 * Recordatorio diario de citas sin desenlace marcado (B.3, docs/tasks/asistencia-valor
 * de cierre.md) — "este job decide si la feature funciona".
 */
export async function sendPendingOutcomeReminderEmail(params: SendPendingOutcomeReminderEmailParams) {
    const resend = getResendClient();
    if (!resend) {
        logger.warn('[Email] Omitiendo recordatorio de desenlace por falta de RESEND_API_KEY.');
        return null;
    }

    const { to, data, organizationId, templateId, customOptions } = params;

    const baseOptions = await resolveOrganizationEmailOptions(organizationId);
    const renderOptions: EmailRenderOptions = {
        ...baseOptions,
        ...(templateId ? { templateId } : {}),
        ...(customOptions ?? {}),
    };

    const rendered = renderEmail(EMAIL_TYPES.PENDING_OUTCOME_REMINDER, data, renderOptions);

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
            logger.error({ error: response.error, to }, '[Email] Resend respondió con error al enviar recordatorio de desenlace');
            return null;
        }

        logger.info({ to, emailId: response.data?.id }, '[Email] Recordatorio de desenlace enviado');
        return response;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, msg }, '[Email] Error al enviar el recordatorio de desenlace con Resend');
        return null;
    }
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export interface SendOrganizationInvitationEmailParams {
    to: string;
    organizationName: string;
    role: string;
    acceptUrl: string | null;
}

/**
 * Correo de invitación a una organización (RBAC, docs/tasks/RBAC-permisos.md
 * FASE C). A diferencia del resto de este archivo, NO usa el sistema de
 * theming de marca blanca (email-theme.ts/email-renderer.ts) — ese sistema
 * es para que la PyME se comunique con SU cliente final; esta es
 * correspondencia operativa de la plataforma Datagol hacia un miembro de
 * equipo, así que usa el remitente/plantilla fijos de la plataforma
 * (getFromEmail()), plantilla HTML simple propia.
 *
 * El token NUNCA se pasa a esta función — solo `acceptUrl`, ya construido
 * por el llamador con el token en claro (nunca persistido en claro en
 * ningún otro lugar). `acceptUrl` es `null` cuando `FRONTEND_APP_URL` no
 * está configurada — el correo lo indica en vez de inventar un dominio.
 */
export async function sendOrganizationInvitationEmail(params: SendOrganizationInvitationEmailParams) {
    const resend = getResendClient();
    if (!resend) {
        logger.warn('[Email] Omitiendo correo de invitación por falta de RESEND_API_KEY.');
        return null;
    }

    const { to, organizationName, role, acceptUrl } = params;
    const safeOrgName = escapeHtml(organizationName);
    const safeRole = escapeHtml(role);

    const html = `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
            <h2>Te invitaron a ${safeOrgName}</h2>
            <p>Te invitaron a unirte a <strong>${safeOrgName}</strong> en Datagol con el rol <strong>${safeRole}</strong>.</p>
            ${
                acceptUrl
                    ? `<p><a href="${acceptUrl}" style="display:inline-block;padding:10px 20px;background:#111827;color:#fff;text-decoration:none;border-radius:6px;">Aceptar invitación</a></p>`
                    : '<p>Pide a quien te invitó el enlace de aceptación — no se pudo generar automáticamente.</p>'
            }
            <p style="color:#6b7280;font-size:12px;">Este enlace vence en 7 días y solo puede usarse una vez. Si no esperabas esta invitación, puedes ignorar este correo.</p>
        </div>
    `.trim();
    const text = acceptUrl
        ? `Te invitaron a unirte a ${organizationName} en Datagol con el rol ${role}. Acepta aquí: ${acceptUrl} (vence en 7 días).`
        : `Te invitaron a unirte a ${organizationName} en Datagol con el rol ${role}. Pide a quien te invitó el enlace de aceptación.`;

    try {
        const response = await resend.emails.send({
            from: getFromEmail(),
            to,
            subject: `Te invitaron a ${organizationName} en Datagol`,
            html,
            text,
        });

        if (response.error) {
            logger.error({ error: response.error, to }, '[Email] Resend respondió con error al enviar invitación');
            return null;
        }

        logger.info({ to, emailId: response.data?.id }, '[Email] Correo de invitación enviado');
        return response;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, msg }, '[Email] Error al enviar el correo de invitación con Resend');
        return null;
    }
}

