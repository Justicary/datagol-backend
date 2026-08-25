import { FastifyInstance } from 'fastify';
import { REPORT_TYPES, REPORT_STATUSES, REPORT_CHANNELS, type ReportType, type ReportDeliveryLog } from '../types/reports.js';
import { collectReportData, hasReportActivity, type ReportData, type PlanningReportData, type ExecutiveReportData } from './report-data-service.js';
import { generateReportNarrative } from './report-generation-service.js';
import { uploadWeeklyReportHtml, generateReportSignedUrl } from './report-storage-service.js';
import { getReportsSettings } from './report-settings-service.js';
import { sendWeeklyReportEmail, resolveOrganizationEmailOptions } from './email.js';
import { sendWeeklyReportWhatsApp } from './report-whatsapp-service.js';
import { renderEmail } from './email-renderer.js';
import { EMAIL_TYPES, type WeeklyReportEmailData, type WeeklyReportSection } from '../types/email-templates.js';
import { getOrganizationFeatures } from './entitlements.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { getCompetitorAnalysisForReport } from './competitor-comparison-service.js';

export interface GenerateWeeklyReportParams {
    organizationId: string;
    reportType: ReportType;
    weekStart: string;
}

export interface GenerateWeeklyReportResult {
    /** `false` si el slot semanal ya existía — idempotencia de B.1, no es un error. */
    claimed: boolean;
    reportId?: string;
    status?: string;
}

const REQUIRED_FEATURE: Record<ReportType, string> = {
    [REPORT_TYPES.PLANNING]: FEATURE_KEYS.WEEKLY_PLANNING_REPORT,
    [REPORT_TYPES.EXECUTIVE]: FEATURE_KEYS.WEEKLY_EXECUTIVE_REPORT,
};


async function finalizeReport(
    fastify: FastifyInstance,
    reportId: string,
    patch: {
        status: string;
        data?: Record<string, unknown>;
        narrative?: string | null;
        storagePath?: string | null;
        fileSizeBytes?: number | null;
        deliveryLog?: ReportDeliveryLog;
        error?: string | null;
    }
): Promise<void> {
    const { error } = await fastify.supabaseAdmin
        .from('weekly_reports')
        .update({
            status: patch.status,
            ...(patch.data !== undefined ? { data: patch.data } : {}),
            ...(patch.narrative !== undefined ? { narrative: patch.narrative } : {}),
            ...(patch.storagePath !== undefined ? { storage_path: patch.storagePath } : {}),
            ...(patch.fileSizeBytes !== undefined ? { file_size_bytes: patch.fileSizeBytes } : {}),
            ...(patch.deliveryLog !== undefined ? { delivery_log: patch.deliveryLog } : {}),
            ...(patch.error !== undefined ? { error: patch.error } : {}),
            generated_at: new Date().toISOString(),
        })
        .eq('id', reportId);

    if (error) {
        fastify.log.error({ err: error.message, reportId }, '[WeeklyReport] Error finalizando fila de weekly_reports');
    }
}

function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
    } catch {
        return iso;
    }
}

function s(value: unknown): string {
    return value === null || value === undefined || value === '' ? '—' : String(value);
}

/**
 * Convierte el objeto de datos (ya calculado en SQL) en secciones tabulares
 * para el correo/HTML — nunca interpreta ni recalcula, solo formatea texto.
 */
function buildPlanningSections(data: PlanningReportData): WeeklyReportSection[] {
    const sections: WeeklyReportSection[] = [];

    if (data.appointmentsByDay.length > 0) {
        sections.push({
            title: 'Citas de la semana',
            rows: data.appointmentsByDay.map((a) => ({
                Fecha: fmtDate(a.start_time),
                Cliente: s(a.customer_name),
                Estado: s(a.status ?? 'sin confirmar'),
            })),
        });
    }

    if (data.unconfirmedAppointments.length > 0) {
        sections.push({
            title: 'Citas sin confirmar',
            rows: data.unconfirmedAppointments.map((a) => ({ Fecha: fmtDate(a.start_time), Cliente: s(a.customer_name) })),
        });
    }

    if (data.hotLeadsPending.length > 0) {
        sections.push({
            title: 'Prospectos calientes sin atender',
            rows: data.hotLeadsPending.map((l) => ({
                Nombre: s(l.full_name),
                Teléfono: s(l.phone_e164),
                Motivo: s(l.inquiry_reason),
                Desde: fmtDate(l.created_at),
            })),
        });
    }

    if (data.overdueFollowups.length > 0) {
        sections.push({
            title: 'Seguimientos vencidos',
            rows: data.overdueFollowups.map((f) => ({
                Nombre: s(f.full_name),
                Teléfono: s(f.contact_phone),
                Vencía: fmtDate(f.followup_at),
                Notas: s(f.followup_notes),
            })),
        });
    }

    if (data.stalledContacts.length > 0) {
        sections.push({
            title: 'Con cita agendada pero sin cita futura (se agendó y se canceló)',
            rows: data.stalledContacts.map((c) => ({ Nombre: s(c.full_name), Teléfono: s(c.phone_e164) })),
        });
    }

    if (data.dailyLoad.length > 0) {
        sections.push({
            title: 'Carga por día',
            rows: data.dailyLoad.map((d) => ({
                Día: s(d.day),
                Citas: s(d.appointment_count),
                Saturado: d.is_high_load ? 'Sí' : 'No',
            })),
        });
    }

    if (data.agendaGapsMinutes) {
        sections.push({
            title: 'Capacidad libre por día (dentro del horario de atención)',
            rows: data.agendaGapsMinutes.map((g) => ({
                Día: s(g.day),
                'Minutos libres': s(g.free_minutes),
            })),
        });
    }

    return sections;
}

function buildExecutiveSections(data: ExecutiveReportData): WeeklyReportSection[] {
    const sections: WeeklyReportSection[] = [];

    sections.push({
        title: 'Esta semana vs. la anterior',
        rows: [
            {
                Conversaciones: `${s(data.totals.conversations.current)} (semana previa: ${s(data.totals.conversations.previous)})`,
                'Citas agendadas': `${s(data.totals.appointmentsBooked.current)} (semana previa: ${s(data.totals.appointmentsBooked.previous)})`,
            },
        ],
    });

    if (data.byChannel.length > 0) {
        sections.push({
            title: 'Desglose por canal',
            rows: data.byChannel.map((c) => ({
                Canal: s(c.channel),
                Conversaciones: s(c.total),
                'Citas agendadas': s(c.booked),
                'Conversión a cita': c.conversion_rate_pct !== null ? `${c.conversion_rate_pct}%` : '—',
            })),
        });
    }

    sections.push({
        title: 'Costo',
        rows: [{ Total: `$${s(data.costUsd.totalUsd)} USD`, 'Por prospecto': data.costUsd.perProspectUsd !== null ? `$${data.costUsd.perProspectUsd} USD` : '—' }],
    });

    if (data.lostProspects.length > 0) {
        sections.push({
            title: 'Prospectos perdidos',
            rows: data.lostProspects.map((l) => ({ Razón: s(l.lost_reason), Total: s(l.total) })),
        });
    }

    if (data.pipelineMovement.length > 0) {
        sections.push({
            title: 'Movimiento de pipeline',
            rows: data.pipelineMovement.map((m) => ({ De: s(m.from_stage ?? 'sin etapa previa'), A: s(m.to_stage), Total: s(m.total) })),
        });
    }

    if (data.recurringTopics.length > 0) {
        sections.push({
            title: 'Temas recurrentes en las consultas',
            rows: data.recurringTopics.map((t) => ({ Tema: s(t.topic), Menciones: s(t.total) })),
        });
    }

    const alertRows: Record<string, string>[] = [];
    if (data.alerts.isDurationAnomalous) {
        alertRows.push({
            Alerta: 'Duración media de llamada anómala',
            Detalle: `${s(data.alerts.avgCallDurationSeconds)}s esta semana vs. ${s(data.alerts.baselineAvgCallDurationSeconds)}s de línea base`,
        });
    }
    if (data.alerts.llmCredentialError) {
        alertRows.push({ Alerta: 'Credencial de LLM con error de validación', Detalle: s(data.alerts.llmCredentialError) });
    }
    if (alertRows.length > 0) {
        sections.push({ title: 'Alertas', rows: alertRows });
    }

    if (data.competitorAnalysis) {
        sections.push({
            title: 'Análisis de competencia (aproximado, basado en contenido público)',
            rows: data.competitorAnalysis.sites.map((site) => {
                let estado: string;
                let nuevo = '—';
                let desaparecio = '—';

                if (site.status !== 'ok') {
                    estado = describeCompetitorStatus(site.status);
                } else if (site.isBaseline) {
                    estado = 'Línea base establecida esta semana, sin comparación previa';
                } else {
                    estado = 'Comparado contra la semana anterior';
                    nuevo = site.addedLines.length > 0 ? site.addedLines.join(' / ') : '—';
                    desaparecio = site.removedLines.length > 0 ? site.removedLines.join(' / ') : '—';
                }

                return {
                    Sitio: s(site.label ?? site.url),
                    Estado: estado,
                    'Contenido nuevo': nuevo,
                    'Contenido que desapareció': desaparecio,
                };
            }),
        });
    }

    return sections;
}

function describeCompetitorStatus(status: string): string {
    switch (status) {
        case 'blocked_by_robots':
            return 'robots.txt de ese sitio prohíbe el acceso';
        case 'timeout':
            return 'El sitio no respondió a tiempo';
        case 'http_error':
            return 'El sitio devolvió un error HTTP';
        case 'network_error':
            return 'No se pudo contactar al sitio';
        default:
            return 'Sin datos esta semana';
    }
}

function buildReportSections(reportType: ReportType, data: ReportData): WeeklyReportSection[] {
    return reportType === REPORT_TYPES.PLANNING
        ? buildPlanningSections(data as PlanningReportData)
        : buildExecutiveSections(data as ExecutiveReportData);
}

/**
 * Titular de 1-2 líneas para el resumen de WhatsApp (B.4: "WhatsApp lleva el
 * titular, el correo el detalle"). No usa `narrative` (puede ser larga o
 * `null` en el fallback tabular) — se arma directo desde los datos.
 */
function buildWhatsAppHeadline(reportType: ReportType, data: ReportData): string {
    if (reportType === REPORT_TYPES.PLANNING) {
        const d = data as PlanningReportData;
        return `${d.hotLeadsPending.length} prospectos calientes sin atender, ${d.unconfirmedAppointments.length} citas sin confirmar esta semana.`;
    }
    const d = data as ExecutiveReportData;
    return `${d.totals.conversations.current} conversaciones esta semana (${d.totals.conversations.previous} la anterior), costo total $${d.costUsd.totalUsd} USD.`;
}

/**
 * Orquesta la Fase B completa para una organización/tipo/semana: reclama el
 * slot de forma atómica (idempotencia de B.1), recolecta datos (SQL puro),
 * genera la narrativa (o cae al reporte sin prosa), sube el HTML a Storage,
 * y entrega por los canales configurados.
 */
export async function generateAndDeliverWeeklyReport(
    fastify: FastifyInstance,
    params: GenerateWeeklyReportParams
): Promise<GenerateWeeklyReportResult> {
    const { organizationId, reportType, weekStart } = params;

    // 1. Reclamo atómico: si otra ejecución ya insertó esta fila, la
    // restricción UNIQUE lo rechaza con 23505 — no es un error, es la
    // idempotencia funcionando ("un reporte por organización por semana por tipo").
    const { data: claimedRow, error: claimError } = await fastify.supabaseAdmin
        .from('weekly_reports')
        .insert({
            organization_id: organizationId,
            report_type: reportType,
            week_start: weekStart,
            status: REPORT_STATUSES.GENERATING,
            data: {},
        })
        .select('id')
        .maybeSingle();

    if (claimError) {
        if (claimError.code === '23505') {
            fastify.log.info({ organizationId, reportType, weekStart }, '[WeeklyReport] Ya existe un reporte para esta semana, se omite');
            return { claimed: false };
        }
        fastify.log.error({ err: claimError.message, organizationId, reportType }, '[WeeklyReport] Error reclamando slot semanal');
        throw new Error(`No se pudo reclamar el slot de reporte semanal: ${claimError.message}`);
    }
    if (!claimedRow) {
        return { claimed: false };
    }
    const reportId = claimedRow.id as string;

    try {
        // 2. Verificar la feature justo antes de generar el efecto (AGENTS.md §16)
        // — el sweep no filtra por feature (ver migración 36), así que esta es
        // la única verificación autoritativa.
        const features = await getOrganizationFeatures(organizationId);
        if (!features.has(REQUIRED_FEATURE[reportType])) {
            await finalizeReport(fastify, reportId, {
                status: REPORT_STATUSES.FAILED,
                error: 'La feature no está habilitada para esta organización.',
            });
            return { claimed: true, reportId, status: REPORT_STATUSES.FAILED };
        }

        // 3. Recolección de datos — todo el cómputo numérico vive en SQL.
        const data = await collectReportData(fastify, reportType, organizationId, weekStart);

        // 3b. Análisis de competencia (Fase C) — solo en el reporte ejecutivo,
        // solo si la organización tiene la feature aparte habilitada, y solo
        // LEE snapshots ya calculados por sweep-competitor-analysis.ts (nunca
        // dispara un fetch en vivo aquí).
        if (reportType === REPORT_TYPES.EXECUTIVE && features.has(FEATURE_KEYS.COMPETITOR_ANALYSIS)) {
            const competitorAnalysis = await getCompetitorAnalysisForReport(fastify, organizationId, weekStart);
            if (competitorAnalysis) {
                (data as ExecutiveReportData).competitorAnalysis = competitorAnalysis;
            }
        }

        // 4. Generación de texto con verificación anti-alucinación (B.3).
        const { narrative, recommendations, usedFallback } = await generateReportNarrative(fastify, organizationId, reportType, data);

        const sections = buildReportSections(reportType, data);

        const { data: org } = await fastify.supabaseAdmin
            .from('organizations')
            .select('name, email, phone_number')
            .eq('id', organizationId)
            .maybeSingle();

        const emailData: WeeklyReportEmailData = {
            businessName: org?.name ?? null,
            weekStart: data.weekStart,
            weekEnd: data.weekEnd,
            narrative,
            recommendations,
            sections,
            downloadUrl: null,
        };

        // 5. Renderizar UNA vez el HTML final y subirlo a Storage — es el
        // mismo HTML que se enviará por correo (sendWeeklyReportEmail vuelve a
        // renderizar internamente al enviar; recomputo barato y determinista,
        // no vale la pena encadenar el HTML entre capas por esto).
        const renderOptions = await resolveOrganizationEmailOptions(organizationId);
        const emailType = reportType === REPORT_TYPES.PLANNING ? EMAIL_TYPES.WEEKLY_PLANNING_REPORT : EMAIL_TYPES.WEEKLY_EXECUTIVE_REPORT;
        const rendered = renderEmail(emailType, emailData, renderOptions);
        const upload = await uploadWeeklyReportHtml(fastify, organizationId, reportType, weekStart, rendered.html);
        const downloadUrl = await generateReportSignedUrl(fastify, upload.storagePath);

        // 6. Entrega por los canales configurados.
        const settings = await getReportsSettings(fastify, organizationId);
        const schedule = reportType === REPORT_TYPES.PLANNING ? settings.planning : settings.executive;
        const deliveryLog: ReportDeliveryLog = {};

        if (schedule.channels.includes(REPORT_CHANNELS.EMAIL)) {
            if (!org?.email) {
                deliveryLog.email = { status: 'omitted', reason: 'sin_datos_de_contacto' };
            } else {
                const emailResult = await sendWeeklyReportEmail({
                    to: org.email,
                    organizationId,
                    reportType,
                    data: { ...emailData, downloadUrl },
                });
                deliveryLog.email = emailResult
                    ? { status: 'sent', sentAt: new Date().toISOString() }
                    : { status: 'failed', reason: 'fallo_al_enviar' };
            }
        }

        if (schedule.channels.includes(REPORT_CHANNELS.WHATSAPP)) {
            const templateName = settings.whatsappTemplateName;
            const recipientPhone = settings.whatsappRecipientPhone || org?.phone_number || null;

            if (!templateName) {
                deliveryLog.whatsapp = { status: 'omitted', reason: 'sin_plantilla_configurada' };
            } else if (!recipientPhone) {
                deliveryLog.whatsapp = { status: 'omitted', reason: 'sin_datos_de_contacto' };
            } else {
                const waResult = await sendWeeklyReportWhatsApp(fastify, {
                    organizationId,
                    reportType,
                    phoneE164: recipientPhone,
                    templateName,
                    headline: buildWhatsAppHeadline(reportType, data),
                });
                deliveryLog.whatsapp = waResult.sent
                    ? { status: 'sent', sentAt: new Date().toISOString() }
                    : { status: 'failed', reason: waResult.error ?? waResult.skipReason ?? 'fallo_al_enviar' };
            }
        }

        // 7. Finalizar el registro.
        const finalStatus = !hasReportActivity(reportType, data)
            ? REPORT_STATUSES.SKIPPED_NO_ACTIVITY
            : usedFallback
              ? REPORT_STATUSES.NARRATIVE_FALLBACK
              : REPORT_STATUSES.GENERATED;
        await finalizeReport(fastify, reportId, {
            status: finalStatus,
            data: data as unknown as Record<string, unknown>,
            narrative,
            storagePath: upload.storagePath,
            fileSizeBytes: upload.sizeBytes,
            deliveryLog,
        });

        fastify.log.info({ organizationId, reportType, weekStart, reportId, status: finalStatus }, '[WeeklyReport] Reporte semanal generado y entregado');

        return { claimed: true, reportId, status: finalStatus };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err, organizationId, reportType, weekStart, reportId }, '[WeeklyReport] Error generando el reporte semanal');
        await finalizeReport(fastify, reportId, { status: REPORT_STATUSES.FAILED, error: msg });
        return { claimed: true, reportId, status: REPORT_STATUSES.FAILED };
    }
}

/**
 * Renderiza una vista previa del reporte semanal sin persistir en Storage ni enviar correos.
 */
export async function renderWeeklyReportPreview(
    fastify: FastifyInstance,
    organizationId: string,
    reportType: ReportType
): Promise<{ html: string; subject: string; text?: string; reportType: ReportType }> {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(now.setDate(diff)).toISOString().split('T')[0];

    const data = await collectReportData(fastify, reportType, organizationId, monday);
    const sections = buildReportSections(reportType, data);

    const emailData: WeeklyReportEmailData = {
        businessName: 'Datagol',
        weekStart: data.weekStart,
        weekEnd: data.weekEnd,
        narrative: null,
        recommendations: [],
        sections,
        downloadUrl: null,
    };

    const { data: org } = await fastify.supabaseAdmin
        .from('organizations')
        .select('name')
        .eq('id', organizationId)
        .maybeSingle();
    if (org?.name) {
        emailData.businessName = org.name;
    }

    const renderOptions = await resolveOrganizationEmailOptions(organizationId);
    const emailType = reportType === REPORT_TYPES.PLANNING ? EMAIL_TYPES.WEEKLY_PLANNING_REPORT : EMAIL_TYPES.WEEKLY_EXECUTIVE_REPORT;
    const rendered = renderEmail(emailType, emailData, renderOptions);

    return {
        reportType,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
    };
}
