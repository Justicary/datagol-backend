import { Resend } from 'resend';
import dotenv from 'dotenv';
import { logger } from '../lib/logger.js';

dotenv.config();

export interface SendCallSummaryEmailParams {
  to: string;
  callerPhone?: string;
  summary: string;
  sentiment?: string;
  durationSeconds?: number;
  transcript?: string;
  nextSteps?: string[];
}

let resendClient: Resend | null = null;

function getResendClient(): Resend | null {
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

/**
 * Envía un correo electrónico profesional con el resumen y la transcripción de una llamada.
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
  } = params;

  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  const formattedDuration = `${minutes}m ${seconds}s`;

  let sentimentBadgeColor = '#6B7280';
  const sLower = (sentiment || '').toLowerCase();
  if (sLower.includes('positiv')) sentimentBadgeColor = '#10B981';
  else if (sLower.includes('urgente')) sentimentBadgeColor = '#EF4444';
  else if (sLower.includes('queja')) sentimentBadgeColor = '#F59E0B';
  else if (sLower.includes('neutral')) sentimentBadgeColor = '#3B82F6';

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Resumen de Llamada AI</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f8; color: #111827; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .header { background: #1e293b; padding: 20px 24px; color: #ffffff; }
        .header h1 { margin: 0; font-size: 20px; font-weight: 600; }
        .content { padding: 24px; }
        .badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; color: #ffffff; font-weight: bold; font-size: 11px; text-transform: uppercase; background-color: ${sentimentBadgeColor}; }
        .grid { display: table; width: 100%; margin: 16px 0; border-collapse: separate; border-spacing: 8px 0; }
        .cell { display: table-cell; background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid #e2e8f0; width: 50%; }
        .label { font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 600; }
        .value { font-size: 15px; font-weight: 600; color: #0f172a; margin-top: 4px; }
        .section-title { font-size: 14px; font-weight: 700; color: #334155; margin-top: 20px; text-transform: uppercase; border-bottom: 2px solid #f1f5f9; padding-bottom: 6px; }
        .summary-box { background: #fafafa; border-left: 4px solid #3b82f6; padding: 12px 16px; margin-top: 8px; font-size: 14px; line-height: 1.6; color: #334155; }
        .next-steps-list { margin-top: 8px; padding-left: 20px; font-size: 14px; color: #334155; }
        .next-steps-list li { margin-bottom: 6px; }
        .transcript-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; max-height: 250px; overflow-y: auto; color: #475569; margin-top: 8px; }
        .footer { background: #f8fafc; text-align: center; padding: 16px; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>📞 Reporte de Llamada - Datagol AI</h1>
        </div>
        <div class="content">
          <div style="margin-bottom: 12px;">
            <span class="badge">SENTIMIENTO: ${sentiment.toUpperCase()}</span>
          </div>

          <div class="grid">
            <div class="cell">
              <div class="label">Teléfono Cliente</div>
              <div class="value">${callerPhone}</div>
            </div>
            <div class="cell">
              <div class="label">Duración</div>
              <div class="value">${formattedDuration}</div>
            </div>
          </div>

          <div class="section-title">📝 Resumen Ejecutivo</div>
          <div class="summary-box">
            ${summary.replace(/\n/g, '<br/>')}
          </div>

          ${nextSteps && nextSteps.length > 0
      ? `
          <div class="section-title">📌 Próximos Pasos Recomendados</div>
          <ul class="next-steps-list">
            ${nextSteps.map((step) => `<li>${step}</li>`).join('')}
          </ul>
          `
      : ''
    }

          <div class="section-title">💬 Transcripción Completa</div>
          <div class="transcript-box">${transcript}</div>
        </div>
        <div class="footer">
          Generado y enviado automáticamente por el sistema Datagol AI
        </div>
      </div>
    </body>
    </html>
    `;

  try {
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'Datagol Agentes<info@ia.datagol.net>';
    const response = await resend.emails.send({
      from: fromEmail,
      to,
      subject: `[Llamada - ${sentiment.toUpperCase()}] Resumen de llamada con ${callerPhone}`,
      html: htmlContent,
    });

    logger.info({ to, emailId: response.data?.id }, '[Email] Correo de resumen de llamada enviado');
    return response;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, msg }, '[Email] Error al enviar el correo con Resend');
    return null;
  }
}

export interface SendHotLeadAlertEmailParams {
  to: string;
  leadName?: string | null;
  leadPhone?: string | null;
  businessName?: string | null;
  inquiryReason?: string | null;
  followupNotes?: string | null;
}

/**
 * Fase 4.1 — Alerta urgente de prospecto caliente sin cita agendada. Es el
 * job que más importa del sistema: el objetivo es que el negocio la reciba
 * en menos de un minuto para poder llamar de vuelta mientras el interés del
 * prospecto sigue fresco. Tono deliberadamente distinto (urgente, accionable)
 * del resumen general de `sendCallSummaryEmail`.
 */
export async function sendHotLeadAlertEmail(params: SendHotLeadAlertEmailParams) {
  const resend = getResendClient();
  if (!resend) {
    logger.warn('[Email] Omitiendo alerta de prospecto caliente por falta de RESEND_API_KEY.');
    return null;
  }

  const { to } = params;
  const leadName = params.leadName || 'Prospecto sin nombre registrado';
  const leadPhone = params.leadPhone || 'No especificado';
  const businessName = params.businessName || 'tu negocio';
  const inquiryReason = params.inquiryReason || 'No especificado';
  const followupNotes = params.followupNotes || null;

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Prospecto caliente sin agendar</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f8; color: #111827; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); border: 3px solid #ef4444; }
        .header { background: #ef4444; padding: 20px 24px; color: #ffffff; }
        .header h1 { margin: 0; font-size: 20px; font-weight: 700; }
        .content { padding: 24px; }
        .cta { background: #fef2f2; border-left: 4px solid #ef4444; padding: 14px 16px; font-size: 15px; font-weight: 600; color: #991b1b; border-radius: 6px; margin-bottom: 16px; }
        .grid { display: table; width: 100%; margin: 16px 0; border-collapse: separate; border-spacing: 8px 0; }
        .cell { display: table-cell; background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid #e2e8f0; width: 50%; }
        .label { font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 600; }
        .value { font-size: 15px; font-weight: 600; color: #0f172a; margin-top: 4px; }
        .section-title { font-size: 14px; font-weight: 700; color: #334155; margin-top: 20px; text-transform: uppercase; border-bottom: 2px solid #f1f5f9; padding-bottom: 6px; }
        .notes-box { background: #fafafa; border-left: 4px solid #f59e0b; padding: 12px 16px; margin-top: 8px; font-size: 14px; line-height: 1.6; color: #334155; }
        .footer { background: #f8fafc; text-align: center; padding: 16px; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🔥 Prospecto caliente sin cita agendada</h1>
        </div>
        <div class="content">
          <div class="cta">Este prospecto colgó interesado pero sin agendar. Llámalo de vuelta ahora mientras el interés sigue fresco.</div>

          <div class="grid">
            <div class="cell">
              <div class="label">Nombre</div>
              <div class="value">${leadName}</div>
            </div>
            <div class="cell">
              <div class="label">Teléfono</div>
              <div class="value">${leadPhone}</div>
            </div>
          </div>

          <div class="section-title">📋 Motivo de la consulta</div>
          <div class="notes-box">${inquiryReason}</div>

          ${followupNotes
      ? `
          <div class="section-title">📝 Notas de seguimiento</div>
          <div class="notes-box">${followupNotes}</div>
          `
      : ''
    }
        </div>
        <div class="footer">
          Alerta automática de prospecto caliente — ${businessName} vía Datagol AI
        </div>
      </div>
    </body>
    </html>
    `;

  try {
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'Datagol Agentes<info@ia.datagol.net>';
    const response = await resend.emails.send({
      from: fromEmail,
      to,
      subject: `🔥 Prospecto caliente sin agendar — actuar ahora (${leadPhone})`,
      html: htmlContent,
    });

    logger.info({ to, emailId: response.data?.id }, '[Email] Alerta de prospecto caliente enviada');
    return response;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, msg }, '[Email] Error al enviar la alerta de prospecto caliente con Resend');
    return null;
  }
}

export interface SendProspectSummaryEmailParams {
  to: string;
  prospectName?: string | null;
  businessName?: string | null;
  summary?: string | null;
  followupNotes?: string | null;
}

/**
 * Fase 4.3 — Resumen de cortesía enviado al propio prospecto (no al
 * negocio). Solo se invoca cuando hubo un compromiso explícito de enviarle
 * algo y dejó un correo — la verificación de `opted_out` y del compromiso
 * vive en el job `send-prospect-summary`, no aquí. Tono cercano; no incluye
 * la transcripción cruda (eso es para la minuta interna del negocio).
 */
export async function sendProspectSummaryEmail(params: SendProspectSummaryEmailParams) {
  const resend = getResendClient();
  if (!resend) {
    logger.warn('[Email] Omitiendo resumen al prospecto por falta de RESEND_API_KEY.');
    return null;
  }

  const { to } = params;
  const prospectName = params.prospectName || 'Estimado cliente';
  const businessName = params.businessName || 'nuestro equipo';
  const followupNotes = params.followupNotes || null;
  const summary = params.summary || 'Gracias por tu llamada. Nos pondremos en contacto contigo pronto.';

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Resumen de tu llamada</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f8; color: #111827; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .header { background: #1e293b; padding: 20px 24px; color: #ffffff; }
        .header h1 { margin: 0; font-size: 20px; font-weight: 600; }
        .content { padding: 24px; font-size: 15px; line-height: 1.6; color: #334155; }
        .summary-box { background: #fafafa; border-left: 4px solid #3b82f6; padding: 12px 16px; margin-top: 12px; font-size: 14px; line-height: 1.6; color: #334155; }
        .footer { background: #f8fafc; text-align: center; padding: 16px; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Gracias por tu llamada</h1>
        </div>
        <div class="content">
          <p>Hola ${prospectName},</p>
          <p>Gracias por comunicarte con ${businessName}. Este es un resumen de lo que conversamos:</p>
          <div class="summary-box">${summary.replace(/\n/g, '<br/>')}</div>
          ${followupNotes
      ? `<p style="margin-top:16px;">${followupNotes.replace(/\n/g, '<br/>')}</p>`
      : ''
    }
        </div>
        <div class="footer">
          Enviado por ${businessName} vía Datagol AI
        </div>
      </div>
    </body>
    </html>
    `;

  try {
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'Datagol Agentes<info@ia.datagol.net>';
    const response = await resend.emails.send({
      from: fromEmail,
      to,
      subject: `Resumen de tu llamada con ${businessName}`,
      html: htmlContent,
    });

    logger.info({ to, emailId: response.data?.id }, '[Email] Resumen al prospecto enviado');
    return response;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, msg }, '[Email] Error al enviar el resumen al prospecto con Resend');
    return null;
  }
}
