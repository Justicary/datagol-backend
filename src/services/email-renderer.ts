import {
    EMAIL_TEMPLATES,
    EMAIL_TYPES,
    type EmailTemplateId,
    type EmailTypeId,
    type CallSummaryEmailData,
    type HotLeadEmailData,
    type AppointmentConfirmationEmailData,
    type ProspectSummaryEmailData,
    type CreditsAlertEmailData,
} from '../types/email-templates.js';
import { type SafeEmailTheme, DEFAULT_DATAGOL_EMAIL_THEME } from './email-theme.js';

export const MAX_EMAIL_HTML_BYTES = 90 * 1024; // 90 KB

export interface EmailRenderOptions {
    templateId?: EmailTemplateId | string | null;
    theme?: SafeEmailTheme;
    logoUrl?: string | null;
    footerText?: string | null;
    replyTo?: string | null;
}

export interface RenderedEmail {
    subject: string;
    html: string;
    text: string;
    templateId: EmailTemplateId;
    type: EmailTypeId;
}

function escapeHtml(str: unknown): string {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
}

function getSentimentColor(sentiment: string | null | undefined): string {
    const s = (sentiment || '').toLowerCase();
    if (s.includes('positiv')) return '#10b981';
    if (s.includes('urgente')) return '#ef4444';
    if (s.includes('queja')) return '#f59e0b';
    if (s.includes('neutral')) return '#3b82f6';
    return '#6b7280';
}

interface CommonContentBlock {
    title: string;
    badge?: { label: string; color: string };
    leadParagraph?: string;
    bannerAlert?: { message: string; isUrgent?: boolean };
    metadataGrid?: Array<{ label: string; value: string }>;
    sections: Array<{
        title: string;
        contentHtml: string;
        contentText: string;
        type?: 'box' | 'list' | 'transcript' | 'alert';
    }>;
    primaryAction?: {
        label: string;
        url: string;
    };
    footerNote?: string;
}

/**
 * Normaliza los datos de cada tipo de correo en un bloque de contenido común desacoplado del layout.
 */
function buildContentBlock(
    type: EmailTypeId,
    data: unknown,
    theme: SafeEmailTheme
): { block: CommonContentBlock; subject: string } {
    const businessName = (data as { businessName?: string | null } | null | undefined)?.businessName || 'tu negocio';

    switch (type) {
        case EMAIL_TYPES.CALL_SUMMARY: {
            const d = (data as CallSummaryEmailData) || { summary: '' };
            const callerPhone = d.callerPhone || 'No especificado';
            const sentiment = d.sentiment || 'neutral';
            const duration = formatDuration(d.durationSeconds || 0);
            const sentimentColor = getSentimentColor(sentiment);

            const nextStepsHtml =
                d.nextSteps && d.nextSteps.length > 0
                    ? `<ul style="margin: 0; padding-left: 20px; font-size: 14px; color: ${theme.text}; line-height: 1.6;">${d.nextSteps.map((s) => `<li style="margin-bottom: 6px;">${escapeHtml(s)}</li>`).join('')}</ul>`
                    : '';
            const nextStepsText = d.nextSteps && d.nextSteps.length > 0 ? d.nextSteps.map((s) => `* ${s}`).join('\n') : '';

            const sections: CommonContentBlock['sections'] = [
                {
                    title: 'Resumen Ejecutivo',
                    contentHtml: `<div style="font-size: 14px; line-height: 1.6; color: ${theme.text};">${escapeHtml(d.summary).replace(/\n/g, '<br/>')}</div>`,
                    contentText: d.summary,
                    type: 'box',
                },
            ];

            if (nextStepsHtml) {
                sections.push({
                    title: 'Próximos Pasos Recomendados',
                    contentHtml: nextStepsHtml,
                    contentText: nextStepsText,
                    type: 'list',
                });
            }

            if (d.transcript) {
                sections.push({
                    title: 'Transcripción Completa',
                    contentHtml: `<div style="font-size: 13px; line-height: 1.5; color: ${theme.textMuted}; white-space: pre-wrap; word-break: break-word;">${escapeHtml(d.transcript)}</div>`,
                    contentText: d.transcript,
                    type: 'transcript',
                });
            }

            return {
                subject: `[Llamada - ${sentiment.toUpperCase()}] Resumen de llamada con ${callerPhone}`,
                block: {
                    title: 'Reporte de Llamada',
                    badge: { label: `SENTIMIENTO: ${sentiment.toUpperCase()}`, color: sentimentColor },
                    metadataGrid: [
                        { label: 'Teléfono Cliente', value: callerPhone },
                        { label: 'Duración', value: duration },
                    ],
                    sections,
                    footerNote: `Generado y enviado automáticamente por Datagol AI para ${businessName}`,
                },
            };
        }

        case EMAIL_TYPES.HOT_LEAD: {
            const d = (data as HotLeadEmailData) || {};
            const leadName = d.leadName || 'Prospecto sin nombre';
            const leadPhone = d.leadPhone || 'No especificado';
            const inquiryReason = d.inquiryReason || 'No especificado';

            const sections: CommonContentBlock['sections'] = [
                {
                    title: 'Motivo de la Consulta',
                    contentHtml: `<div style="font-size: 14px; line-height: 1.6; color: ${theme.text};">${escapeHtml(inquiryReason).replace(/\n/g, '<br/>')}</div>`,
                    contentText: inquiryReason,
                    type: 'box',
                },
            ];

            if (d.followupNotes) {
                sections.push({
                    title: 'Notas de Seguimiento',
                    contentHtml: `<div style="font-size: 14px; line-height: 1.6; color: ${theme.text};">${escapeHtml(d.followupNotes).replace(/\n/g, '<br/>')}</div>`,
                    contentText: d.followupNotes,
                    type: 'box',
                });
            }

            return {
                subject: `🔥 Prospecto caliente sin agendar — actuar ahora (${leadPhone})`,
                block: {
                    title: '🔥 Prospecto Caliente Sin Cita',
                    bannerAlert: {
                        message: 'Este prospecto colgó interesado pero sin agendar. Llámalo de vuelta ahora mientras el interés sigue fresco.',
                        isUrgent: true,
                    },
                    metadataGrid: [
                        { label: 'Nombre', value: leadName },
                        { label: 'Teléfono', value: leadPhone },
                    ],
                    sections,
                    primaryAction:
                        leadPhone && leadPhone !== 'No especificado'
                            ? { label: `Llamar a ${leadPhone}`, url: `tel:${leadPhone.replace(/\s+/g, '')}` }
                            : undefined,
                    footerNote: `Alerta urgente de prospecto caliente — ${businessName} vía Datagol AI`,
                },
            };
        }

        case EMAIL_TYPES.APPOINTMENT_CONFIRMATION: {
            const d = (data as AppointmentConfirmationEmailData) || { customerName: 'Cliente', startTime: '' };
            const customerName = d.customerName || 'Cliente';
            const customerPhone = d.customerPhone || 'No especificado';
            const startTime = d.startTime || 'Por definir';

            const metadataGrid = [
                { label: 'Cliente', value: customerName },
                { label: 'Fecha y Hora', value: startTime },
            ];

            if (customerPhone !== 'No especificado') {
                metadataGrid.push({ label: 'Teléfono', value: customerPhone });
            }
            if (d.serviceAddress) {
                metadataGrid.push({ label: 'Dirección de Servicio', value: d.serviceAddress });
            }

            const sections: CommonContentBlock['sections'] = [];
            if (d.notes) {
                sections.push({
                    title: 'Detalles de la Cita',
                    contentHtml: `<div style="font-size: 14px; line-height: 1.6; color: ${theme.text};">${escapeHtml(d.notes).replace(/\n/g, '<br/>')}</div>`,
                    contentText: d.notes,
                    type: 'box',
                });
            }

            return {
                subject: `Confirmación de tu cita con ${businessName}`,
                block: {
                    title: '📅 Cita Confirmada',
                    leadParagraph: `Hola ${escapeHtml(customerName)}, tu cita con ${escapeHtml(businessName)} ha sido agendada exitosamente.`,
                    metadataGrid,
                    sections,
                    footerNote: `Cita gestionada automáticamente por ${businessName} vía Datagol AI`,
                },
            };
        }

        case EMAIL_TYPES.PROSPECT_SUMMARY: {
            const d = (data as ProspectSummaryEmailData) || {};
            const prospectName = d.prospectName || 'Estimado cliente';
            const summary = d.summary || 'Gracias por comunicarte con nosotros.';

            const sections: CommonContentBlock['sections'] = [
                {
                    title: 'Resumen de la Conversación',
                    contentHtml: `<div style="font-size: 14px; line-height: 1.6; color: ${theme.text};">${escapeHtml(summary).replace(/\n/g, '<br/>')}</div>`,
                    contentText: summary,
                    type: 'box',
                },
            ];

            if (d.followupNotes) {
                sections.push({
                    title: 'Información Adicional',
                    contentHtml: `<div style="font-size: 14px; line-height: 1.6; color: ${theme.text};">${escapeHtml(d.followupNotes).replace(/\n/g, '<br/>')}</div>`,
                    contentText: d.followupNotes,
                    type: 'box',
                });
            }

            return {
                subject: `Resumen de tu llamada con ${businessName}`,
                block: {
                    title: 'Gracias por tu llamada',
                    leadParagraph: `Hola ${escapeHtml(prospectName)}, gracias por comunicarte con ${escapeHtml(businessName)}. Aquí tienes el resumen de lo que platicamos:`,
                    sections,
                    footerNote: `Enviado por ${businessName} vía Datagol AI`,
                },
            };
        }

        case EMAIL_TYPES.CREDITS_ALERT: {
            const d = (data as CreditsAlertEmailData) || { remainingPercentage: 10, threshold: 10 };
            const orgName = d.organizationName || 'tu organización';
            const isUrgent = d.threshold <= 5;

            return {
                subject: `⚠️ Créditos de ElevenLabs al ${d.remainingPercentage}% — ${orgName}`,
                block: {
                    title: `⚠️ Créditos al ${d.remainingPercentage}%`,
                    bannerAlert: {
                        message: `A ${orgName} le queda ${d.remainingPercentage}% de créditos de voz este ciclo de facturación. Si se agotan, tu agente no podrá contestar ni realizar llamadas.`,
                        isUrgent,
                    },
                    sections: [
                        {
                            title: 'Acción Requerida',
                            contentHtml: `<div style="font-size: 14px; line-height: 1.6; color: ${theme.text};">Ingresa a tu panel de ElevenLabs para ampliar tu plan o esperar al siguiente ciclo de renovación.</div>`,
                            contentText: 'Ingresa a tu panel de ElevenLabs para ampliar tu plan o esperar al siguiente ciclo de renovación.',
                            type: 'box',
                        },
                    ],
                    footerNote: 'Alerta automática de infraestructura — Datagol Agentes IA',
                },
            };
        }

        default: {
            throw new Error(`Tipo de correo no soportado: ${type}`);
        }
    }
}

/**
 * Genera la versión text/plain limpia a partir del bloque de contenido.
 */
function generatePlainText(block: CommonContentBlock, subject: string, options: EmailRenderOptions): string {
    const lines: string[] = [];

    lines.push(`=== ${block.title.toUpperCase()} ===`);
    lines.push('');

    if (block.badge) {
        lines.push(`[${block.badge.label}]`);
        lines.push('');
    }

    if (block.bannerAlert) {
        lines.push(`!!! ALERTA: ${block.bannerAlert.message} !!!`);
        lines.push('');
    }

    if (block.leadParagraph) {
        lines.push(block.leadParagraph);
        lines.push('');
    }

    if (block.metadataGrid && block.metadataGrid.length > 0) {
        for (const item of block.metadataGrid) {
            lines.push(`* ${item.label}: ${item.value}`);
        }
        lines.push('');
    }

    for (const sec of block.sections) {
        lines.push(`--- ${sec.title.toUpperCase()} ---`);
        lines.push(sec.contentText);
        lines.push('');
    }

    if (block.primaryAction) {
        lines.push(`>> ${block.primaryAction.label}: ${block.primaryAction.url}`);
        lines.push('');
    }

    lines.push('----------------------------------------');
    if (options.footerText) {
        lines.push(options.footerText);
    }
    if (block.footerNote) {
        lines.push(block.footerNote);
    }

    return lines.join('\n').trim();
}

/**
 * Renderiza el HTML con la plantilla `profesional` (Default).
 * Cabecera sólida con acento, tarjeta blanca con borde suave, bloques de datos claros.
 */
function renderProfesional(block: CommonContentBlock, theme: SafeEmailTheme, options: EmailRenderOptions): string {
    const logoHtml = options.logoUrl
        ? `<img src="${escapeHtml(options.logoUrl)}" alt="Logo" style="max-height: 36px; max-width: 160px; display: block; margin-bottom: 12px; border: 0;" />`
        : '';

    const badgeHtml = block.badge
        ? `<div style="margin-bottom: 16px;"><span style="display: inline-block; padding: 4px 10px; border-radius: 9999px; color: #ffffff; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; background-color: ${block.badge.color};">${escapeHtml(block.badge.label)}</span></div>`
        : '';

    const bannerHtml = block.bannerAlert
        ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 16px; background-color: ${block.bannerAlert.isUrgent ? '#fef2f2' : '#fffbeb'}; border-left: 4px solid ${block.bannerAlert.isUrgent ? '#ef4444' : '#f59e0b'}; border-radius: 6px;">
            <tr><td style="padding: 12px 16px; font-size: 14px; font-weight: 600; color: ${block.bannerAlert.isUrgent ? '#991b1b' : '#92400e'}; line-height: 1.5;">${escapeHtml(block.bannerAlert.message)}</td></tr>
           </table>`
        : '';

    const gridHtml =
        block.metadataGrid && block.metadataGrid.length > 0
            ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 16px 0;">
                <tr>
                  ${block.metadataGrid
                    .map(
                        (m) => `
                    <td width="50%" valign="top" style="padding: 12px; background-color: ${theme.cardBackground}; border: 1px solid ${theme.border}; border-radius: 6px;">
                      <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: ${theme.textMuted}; letter-spacing: 0.5px;">${escapeHtml(m.label)}</div>
                      <div style="font-size: 15px; font-weight: 600; color: ${theme.text}; margin-top: 4px;">${escapeHtml(m.value)}</div>
                    </td>`
                    )
                    .join('<td width="10" style="font-size: 1px;">&nbsp;</td>')}
                </tr>
              </table>`
            : '';

    const sectionsHtml = block.sections
        .map(
            (sec) => `
        <div style="margin-top: 20px;">
          <div style="font-size: 13px; font-weight: 700; text-transform: uppercase; color: ${theme.accentText}; letter-spacing: 0.5px; border-bottom: 2px solid ${theme.border}; padding-bottom: 6px; margin-bottom: 10px;">${escapeHtml(sec.title)}</div>
          <div style="background-color: ${sec.type === 'transcript' ? theme.cardBackground : '#ffffff'}; border: 1px solid ${theme.border}; ${sec.type === 'box' ? `border-left: 4px solid ${theme.accent};` : ''} border-radius: 6px; padding: 14px;">
            ${sec.contentHtml}
          </div>
        </div>`
        )
        .join('');

    const actionHtml = block.primaryAction
        ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 24px;">
            <tr>
              <td align="center">
                <a href="${escapeHtml(block.primaryAction.url)}" style="min-height: 44px; line-height: 44px; display: inline-block; padding: 0 24px; background-color: ${theme.buttonBackground}; color: ${theme.buttonText}; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 6px; text-align: center;">${escapeHtml(block.primaryAction.label)}</a>
              </td>
            </tr>
           </table>`
        : '';

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(block.title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${theme.canvas}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${theme.canvas}; padding: 24px 12px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%; background-color: ${theme.background}; border-radius: 8px; overflow: hidden; border: 1px solid ${theme.border};">
          <!-- Cabecera -->
          <tr>
            <td style="background-color: ${theme.accent}; padding: 24px 28px; color: #ffffff;">
              ${logoHtml}
              <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: -0.2px;">${escapeHtml(block.title)}</h1>
            </td>
          </tr>
          <!-- Contenido -->
          <tr>
            <td style="padding: 24px 28px;">
              ${badgeHtml}
              ${bannerHtml}
              ${block.leadParagraph ? `<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: ${theme.text};">${escapeHtml(block.leadParagraph)}</p>` : ''}
              ${gridHtml}
              ${sectionsHtml}
              ${actionHtml}
            </td>
          </tr>
          <!-- Pie -->
          <tr>
            <td style="background-color: ${theme.cardBackground}; padding: 18px 28px; text-align: center; font-size: 12px; color: ${theme.textMuted}; border-top: 1px solid ${theme.border}; line-height: 1.5;">
              ${options.footerText ? `<div style="margin-bottom: 6px;">${escapeHtml(options.footerText)}</div>` : ''}
              ${block.footerNote ? `<div>${escapeHtml(block.footerNote)}</div>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Renderiza el HTML con la plantilla `minimalista`.
 * Sin cabecera de color sólido, tipografía y aire generoso. Para despachos y consultorios.
 */
function renderMinimalista(block: CommonContentBlock, theme: SafeEmailTheme, options: EmailRenderOptions): string {
    const logoHtml = options.logoUrl
        ? `<img src="${escapeHtml(options.logoUrl)}" alt="Logo" style="max-height: 32px; max-width: 140px; display: block; margin-bottom: 16px; border: 0;" />`
        : '';

    const gridHtml =
        block.metadataGrid && block.metadataGrid.length > 0
            ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 16px 0; border-top: 1px solid ${theme.border}; border-bottom: 1px solid ${theme.border};">
                <tr>
                  ${block.metadataGrid
                    .map(
                        (m) => `
                    <td style="padding: 12px 0;">
                      <div style="font-size: 11px; text-transform: uppercase; color: ${theme.textMuted}; letter-spacing: 0.5px;">${escapeHtml(m.label)}</div>
                      <div style="font-size: 14px; font-weight: 600; color: ${theme.text}; margin-top: 2px;">${escapeHtml(m.value)}</div>
                    </td>`
                    )
                    .join('')}
                </tr>
              </table>`
            : '';

    const sectionsHtml = block.sections
        .map(
            (sec) => `
        <div style="margin-top: 24px;">
          <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: ${theme.textMuted}; letter-spacing: 1px; margin-bottom: 8px;">${escapeHtml(sec.title)}</div>
          <div style="font-size: 14px; line-height: 1.6; color: ${theme.text};">
            ${sec.contentHtml}
          </div>
        </div>`
        )
        .join('');

    const actionHtml = block.primaryAction
        ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 28px;">
            <tr>
              <td>
                <a href="${escapeHtml(block.primaryAction.url)}" style="min-height: 44px; line-height: 44px; display: inline-block; padding: 0 20px; background-color: ${theme.buttonBackground}; color: ${theme.buttonText}; font-size: 14px; font-weight: 600; text-decoration: none; border-radius: 4px; text-align: center;">${escapeHtml(block.primaryAction.label)}</a>
              </td>
            </tr>
           </table>`
        : '';

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(block.title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px; width: 100%; background-color: #ffffff;">
          <!-- Cabecera limpia -->
          <tr>
            <td style="padding-bottom: 20px; border-bottom: 1px solid ${theme.border};">
              ${logoHtml}
              <h1 style="margin: 0; font-size: 22px; font-weight: 600; color: ${theme.accentText}; letter-spacing: -0.3px;">${escapeHtml(block.title)}</h1>
              ${block.badge ? `<div style="margin-top: 8px; font-size: 12px; font-weight: 600; color: ${block.badge.color};">${escapeHtml(block.badge.label)}</div>` : ''}
            </td>
          </tr>
          <!-- Contenido -->
          <tr>
            <td style="padding: 24px 0;">
              ${block.leadParagraph ? `<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: ${theme.text};">${escapeHtml(block.leadParagraph)}</p>` : ''}
              ${gridHtml}
              ${sectionsHtml}
              ${actionHtml}
            </td>
          </tr>
          <!-- Pie -->
          <tr>
            <td style="padding-top: 24px; border-top: 1px solid ${theme.border}; font-size: 12px; color: ${theme.textMuted}; line-height: 1.5;">
              ${options.footerText ? `<div style="margin-bottom: 4px;">${escapeHtml(options.footerText)}</div>` : ''}
              ${block.footerNote ? `<div>${escapeHtml(block.footerNote)}</div>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Renderiza el HTML con la plantilla `corporativo`.
 * Cabecera sólida con logo y título corporativo, secciones delimitadas, pie formal.
 */
function renderCorporativo(block: CommonContentBlock, theme: SafeEmailTheme, options: EmailRenderOptions): string {
    const logoHtml = options.logoUrl
        ? `<img src="${escapeHtml(options.logoUrl)}" alt="Logo" style="max-height: 38px; max-width: 170px; display: block; border: 0;" />`
        : '';

    const gridHtml =
        block.metadataGrid && block.metadataGrid.length > 0
            ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 16px 0; border: 1px solid ${theme.border};">
                ${block.metadataGrid
                    .map(
                        (m, idx) => `
                  <tr style="${idx % 2 === 1 ? `background-color: ${theme.cardBackground};` : ''}">
                    <td width="35%" style="padding: 10px 14px; font-size: 12px; font-weight: 700; color: ${theme.textMuted}; border-bottom: 1px solid ${theme.border}; text-transform: uppercase;">${escapeHtml(m.label)}</td>
                    <td width="65%" style="padding: 10px 14px; font-size: 14px; font-weight: 600; color: ${theme.text}; border-bottom: 1px solid ${theme.border};">${escapeHtml(m.value)}</td>
                  </tr>`
                    )
                    .join('')}
              </table>`
            : '';

    const sectionsHtml = block.sections
        .map(
            (sec) => `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 20px; border: 1px solid ${theme.border}; border-radius: 4px; overflow: hidden;">
          <tr>
            <td style="background-color: ${theme.cardBackground}; padding: 10px 16px; font-size: 12px; font-weight: 700; text-transform: uppercase; color: ${theme.accentText}; border-bottom: 1px solid ${theme.border}; letter-spacing: 0.5px;">
              ${escapeHtml(sec.title)}
            </td>
          </tr>
          <tr>
            <td style="padding: 14px 16px; background-color: #ffffff;">
              ${sec.contentHtml}
            </td>
          </tr>
        </table>`
        )
        .join('');

    const actionHtml = block.primaryAction
        ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 24px;">
            <tr>
              <td align="right">
                <a href="${escapeHtml(block.primaryAction.url)}" style="min-height: 44px; line-height: 44px; display: inline-block; padding: 0 24px; background-color: ${theme.buttonBackground}; color: ${theme.buttonText}; font-size: 14px; font-weight: 700; text-decoration: none; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px;">${escapeHtml(block.primaryAction.label)}</a>
              </td>
            </tr>
           </table>`
        : '';

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(block.title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${theme.canvas}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${theme.canvas}; padding: 24px 12px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%; background-color: ${theme.background}; border: 1px solid ${theme.border};">
          <!-- Barra superior corporativa -->
          <tr>
            <td style="background-color: ${theme.accentSecondary}; padding: 20px 28px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle">${logoHtml || `<span style="font-size: 18px; font-weight: 700; color: #ffffff;">DATAGOL</span>`}</td>
                  <td align="right" valign="middle" style="font-size: 12px; color: #ffffff; text-transform: uppercase; font-weight: 600; letter-spacing: 1px;">COMUNICADO OFICIAL</td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Título principal -->
          <tr>
            <td style="padding: 24px 28px 12px 28px; border-bottom: 2px solid ${theme.accent};">
              <h1 style="margin: 0; font-size: 21px; font-weight: 700; color: ${theme.text};">${escapeHtml(block.title)}</h1>
              ${block.badge ? `<div style="margin-top: 8px;"><span style="display: inline-block; padding: 2px 8px; background-color: ${block.badge.color}; color: #ffffff; font-size: 11px; font-weight: 700; text-transform: uppercase;">${escapeHtml(block.badge.label)}</span></div>` : ''}
            </td>
          </tr>
          <!-- Cuerpo -->
          <tr>
            <td style="padding: 20px 28px;">
              ${block.leadParagraph ? `<p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: ${theme.text};">${escapeHtml(block.leadParagraph)}</p>` : ''}
              ${gridHtml}
              ${sectionsHtml}
              ${actionHtml}
            </td>
          </tr>
          <!-- Pie formal -->
          <tr>
            <td style="background-color: ${theme.cardBackground}; padding: 18px 28px; font-size: 11px; color: ${theme.textMuted}; border-top: 1px solid ${theme.border}; line-height: 1.5;">
              ${options.footerText ? `<div style="font-weight: 600; margin-bottom: 4px;">${escapeHtml(options.footerText)}</div>` : ''}
              ${block.footerNote ? `<div>${escapeHtml(block.footerNote)}</div>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Renderiza el HTML con la plantilla `calido`.
 * Bordes redondeados, acento suave, tono cercano y amigable. Comercio, salud, B2C.
 */
function renderCalido(block: CommonContentBlock, theme: SafeEmailTheme, options: EmailRenderOptions): string {
    const logoHtml = options.logoUrl
        ? `<img src="${escapeHtml(options.logoUrl)}" alt="Logo" style="max-height: 36px; max-width: 150px; display: block; margin: 0 auto 16px auto; border: 0;" />`
        : '';

    const gridHtml =
        block.metadataGrid && block.metadataGrid.length > 0
            ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 16px 0;">
                <tr>
                  ${block.metadataGrid
                    .map(
                        (m) => `
                    <td width="50%" valign="top" style="padding: 14px; background-color: ${theme.cardBackground}; border-radius: 12px; border: 1px solid ${theme.border};">
                      <div style="font-size: 12px; font-weight: 600; color: ${theme.textMuted};">${escapeHtml(m.label)}</div>
                      <div style="font-size: 16px; font-weight: 700; color: ${theme.accentText}; margin-top: 4px;">${escapeHtml(m.value)}</div>
                    </td>`
                    )
                    .join('<td width="12" style="font-size: 1px;">&nbsp;</td>')}
                </tr>
              </table>`
            : '';

    const sectionsHtml = block.sections
        .map(
            (sec) => `
        <div style="margin-top: 18px; padding: 16px; background-color: ${theme.cardBackground}; border-radius: 12px; border: 1px solid ${theme.border};">
          <div style="font-size: 14px; font-weight: 700; color: ${theme.accentText}; margin-bottom: 8px;">${escapeHtml(sec.title)}</div>
          <div style="font-size: 14px; line-height: 1.6; color: ${theme.text};">
            ${sec.contentHtml}
          </div>
        </div>`
        )
        .join('');

    const actionHtml = block.primaryAction
        ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 24px;">
            <tr>
              <td align="center">
                <a href="${escapeHtml(block.primaryAction.url)}" style="min-height: 44px; line-height: 44px; display: inline-block; padding: 0 28px; background-color: ${theme.buttonBackground}; color: ${theme.buttonText}; font-size: 15px; font-weight: 700; text-decoration: none; border-radius: 24px; text-align: center;">${escapeHtml(block.primaryAction.label)}</a>
              </td>
            </tr>
           </table>`
        : '';

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(block.title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8fafc; padding: 24px 12px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 580px; width: 100%; background-color: #ffffff; border-radius: 16px; border: 1px solid ${theme.border}; padding: 28px 24px;">
          <!-- Cabecera cálida centrada -->
          <tr>
            <td align="center" style="padding-bottom: 20px; border-bottom: 1px dashed ${theme.border};">
              ${logoHtml}
              <h1 style="margin: 0; font-size: 22px; font-weight: 700; color: ${theme.accentText};">${escapeHtml(block.title)}</h1>
              ${block.badge ? `<div style="margin-top: 8px;"><span style="display: inline-block; padding: 4px 12px; background-color: ${block.badge.color}; color: #ffffff; border-radius: 16px; font-size: 11px; font-weight: 700;">${escapeHtml(block.badge.label)}</span></div>` : ''}
            </td>
          </tr>
          <!-- Contenido -->
          <tr>
            <td style="padding: 20px 0;">
              ${block.leadParagraph ? `<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: ${theme.text}; text-align: center;">${escapeHtml(block.leadParagraph)}</p>` : ''}
              ${gridHtml}
              ${sectionsHtml}
              ${actionHtml}
            </td>
          </tr>
          <!-- Pie -->
          <tr>
            <td align="center" style="padding-top: 20px; border-top: 1px dashed ${theme.border}; font-size: 12px; color: ${theme.textMuted}; line-height: 1.5;">
              ${options.footerText ? `<div style="margin-bottom: 4px;">${escapeHtml(options.footerText)}</div>` : ''}
              ${block.footerNote ? `<div>${escapeHtml(block.footerNote)}</div>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Renderiza el HTML con la plantilla `compacto`.
 * Todo en una sola pantalla, optimizado para móvil sin scroll innecesario.
 */
function renderCompacto(block: CommonContentBlock, theme: SafeEmailTheme, options: EmailRenderOptions): string {
    const logoHtml = options.logoUrl
        ? `<img src="${escapeHtml(options.logoUrl)}" alt="Logo" style="max-height: 24px; max-width: 100px; display: inline-block; vertical-align: middle; margin-right: 8px; border: 0;" />`
        : '';

    const gridHtml =
        block.metadataGrid && block.metadataGrid.length > 0
            ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 8px 0; background-color: ${theme.cardBackground}; border-radius: 4px;">
                <tr>
                  ${block.metadataGrid
                    .map(
                        (m) => `
                    <td style="padding: 8px 10px;">
                      <span style="font-size: 11px; font-weight: 700; color: ${theme.textMuted}; text-transform: uppercase;">${escapeHtml(m.label)}:</span>
                      <span style="font-size: 13px; font-weight: 600; color: ${theme.text}; margin-left: 4px;">${escapeHtml(m.value)}</span>
                    </td>`
                    )
                    .join('')}
                </tr>
              </table>`
            : '';

    const sectionsHtml = block.sections
        .map(
            (sec) => `
        <div style="margin-top: 10px;">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: ${theme.accentText}; margin-bottom: 2px;">${escapeHtml(sec.title)}</div>
          <div style="font-size: 13px; line-height: 1.4; color: ${theme.text}; background-color: ${theme.cardBackground}; padding: 8px 10px; border-radius: 4px;">
            ${sec.contentHtml}
          </div>
        </div>`
        )
        .join('');

    const actionHtml = block.primaryAction
        ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 12px;">
            <tr>
              <td align="center">
                <a href="${escapeHtml(block.primaryAction.url)}" style="min-height: 44px; line-height: 44px; display: block; width: 100%; background-color: ${theme.buttonBackground}; color: ${theme.buttonText}; font-size: 14px; font-weight: 600; text-decoration: none; border-radius: 4px; text-align: center;">${escapeHtml(block.primaryAction.label)}</a>
              </td>
            </tr>
           </table>`
        : '';

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(block.title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${theme.canvas}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${theme.canvas}; padding: 12px 6px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 480px; width: 100%; background-color: ${theme.background}; border: 1px solid ${theme.border}; border-radius: 6px; padding: 14px 16px;">
          <!-- Cabecera compacta -->
          <tr>
            <td style="padding-bottom: 8px; border-bottom: 1px solid ${theme.border};">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle">
                    ${logoHtml}
                    <strong style="font-size: 15px; color: ${theme.text};">${escapeHtml(block.title)}</strong>
                  </td>
                  ${block.badge ? `<td align="right" valign="middle"><span style="font-size: 10px; font-weight: 700; color: #ffffff; background-color: ${block.badge.color}; padding: 2px 6px; border-radius: 4px;">${escapeHtml(block.badge.label)}</span></td>` : ''}
                </tr>
              </table>
            </td>
          </tr>
          <!-- Contenido compacto -->
          <tr>
            <td style="padding: 8px 0;">
              ${block.leadParagraph ? `<p style="margin: 4px 0 8px 0; font-size: 13px; line-height: 1.4; color: ${theme.text};">${escapeHtml(block.leadParagraph)}</p>` : ''}
              ${gridHtml}
              ${sectionsHtml}
              ${actionHtml}
            </td>
          </tr>
          <!-- Pie compacto -->
          <tr>
            <td style="padding-top: 8px; border-top: 1px solid ${theme.border}; font-size: 11px; color: ${theme.textMuted}; text-align: center;">
              ${options.footerText ? `${escapeHtml(options.footerText)} &bull; ` : ''}${block.footerNote ? escapeHtml(block.footerNote) : 'Datagol AI'}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Valida que el tamaño del HTML no sobrepase el umbral de 90 KB.
 */
export function validateEmailPayloadSize(html: string): void {
    const sizeBytes = Buffer.byteLength(html, 'utf8');
    if (sizeBytes >= MAX_EMAIL_HTML_BYTES) {
        throw new Error(
            `El tamaño del HTML del correo (${(sizeBytes / 1024).toFixed(2)} KB) excede el límite máximo permitido de 90 KB.`
        );
    }
}

/**
 * Motor central de renderizado de correos.
 * Recibe el tipo de correo, los datos, el tema y la plantilla seleccionada.
 */
export function renderEmail(
    type: EmailTypeId,
    data: unknown,
    options: EmailRenderOptions = {}
): RenderedEmail {
    const rawTemplate = options.templateId || EMAIL_TEMPLATES.PROFESIONAL;
    const templateId: EmailTemplateId = (Object.values(EMAIL_TEMPLATES) as string[]).includes(rawTemplate)
        ? (rawTemplate as EmailTemplateId)
        : EMAIL_TEMPLATES.PROFESIONAL;

    const theme = options.theme || DEFAULT_DATAGOL_EMAIL_THEME;
    const { block, subject } = buildContentBlock(type, data, theme);

    let html: string;
    switch (templateId) {
        case EMAIL_TEMPLATES.MINIMALISTA:
            html = renderMinimalista(block, theme, options);
            break;
        case EMAIL_TEMPLATES.CORPORATIVO:
            html = renderCorporativo(block, theme, options);
            break;
        case EMAIL_TEMPLATES.CALIDO:
            html = renderCalido(block, theme, options);
            break;
        case EMAIL_TEMPLATES.COMPACTO:
            html = renderCompacto(block, theme, options);
            break;
        case EMAIL_TEMPLATES.PROFESIONAL:
        default:
            html = renderProfesional(block, theme, options);
            break;
    }

    validateEmailPayloadSize(html);
    const text = generatePlainText(block, subject, options);

    return {
        subject,
        html,
        text,
        templateId,
        type,
    };
}
