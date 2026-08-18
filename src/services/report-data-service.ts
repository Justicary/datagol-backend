import { FastifyInstance } from 'fastify';
import { REPORT_TYPES, type ReportType } from '../types/reports.js';

export interface PlanningReportData {
    weekStart: string;
    weekEnd: string;
    appointmentsByDay: Array<{ id: string; customer_name: string | null; start_time: string; status: string | null; local_day: string }>;
    unconfirmedAppointments: Array<{ id: string; customer_name: string | null; start_time: string }>;
    hotLeadsPending: Array<{
        lead_id: string;
        full_name: string | null;
        phone_e164: string | null;
        business_name: string | null;
        inquiry_reason: string | null;
        created_at: string;
    }>;
    overdueFollowups: Array<{
        lead_id: string;
        full_name: string | null;
        contact_phone: string | null;
        followup_notes: string | null;
        followup_at: string;
    }>;
    stalledContacts: Array<{ contact_id: string; full_name: string | null; phone_e164: string | null }>;
    dailyLoad: Array<{ day: string; appointment_count: number; is_high_load: boolean }>;
    /** `null` cuando la organización no tiene `integration_settings.business_hours` configurado. */
    agendaGapsMinutes: Array<{ day: string; bh_minutes: number; free_minutes: number }> | null;
}

export interface ExecutiveReportData {
    weekStart: string;
    weekEnd: string;
    totals: {
        conversations: { current: number; previous: number };
        appointmentsBooked: { current: number; previous: number };
    };
    byChannel: Array<{ channel: string; total: number; booked: number; conversion_rate_pct: number | null }>;
    lostProspects: Array<{ lost_reason: string; total: number }>;
    pipelineMovement: Array<{ from_stage: string | null; to_stage: string; total: number }>;
    recurringTopics: Array<{ topic: string; total: number }>;
    costUsd: { totalUsd: number; perProspectUsd: number | null };
    alerts: {
        avgCallDurationSeconds: number | null;
        baselineAvgCallDurationSeconds: number | null;
        isDurationAnomalous: boolean;
        /** Sustituye a "credencial por vencer" (B.2) — no hay campo de expiración en el esquema, ver migración 36. */
        llmCredentialError: string | null;
    };
    /**
     * Sección opcional de Fase C (análisis de competencia) — se agrega en
     * weekly-report-service.ts SOLO si la organización tiene la feature
     * `competitor_analysis` habilitada. `undefined` cuando no aplica; nunca
     * se rellena con un valor inventado.
     */
    competitorAnalysis?: import('../types/competitor-analysis.js').CompetitorAnalysisReportData | null;
}

export type ReportData = PlanningReportData | ExecutiveReportData;

/**
 * Envoltorios tipados de `collect_planning_report_data`/`collect_executive_report_data`
 * (db/migrations/36_weekly_reports.sql) — todo el cómputo numérico vive en SQL,
 * este servicio solo tipa la respuesta, nunca recalcula nada.
 */
export async function collectPlanningReportData(
    fastify: FastifyInstance,
    organizationId: string,
    weekStart: string
): Promise<PlanningReportData> {
    const { data, error } = await fastify.supabaseAdmin.rpc('collect_planning_report_data', {
        p_organization_id: organizationId,
        p_week_start: weekStart,
    });
    if (error) {
        throw new Error(`collect_planning_report_data falló para org=${organizationId}: ${error.message}`);
    }
    return data as PlanningReportData;
}

export async function collectExecutiveReportData(
    fastify: FastifyInstance,
    organizationId: string,
    weekStart: string
): Promise<ExecutiveReportData> {
    const { data, error } = await fastify.supabaseAdmin.rpc('collect_executive_report_data', {
        p_organization_id: organizationId,
        p_week_start: weekStart,
    });
    if (error) {
        throw new Error(`collect_executive_report_data falló para org=${organizationId}: ${error.message}`);
    }
    return data as ExecutiveReportData;
}

export async function collectReportData(
    fastify: FastifyInstance,
    reportType: ReportType,
    organizationId: string,
    weekStart: string
): Promise<ReportData> {
    return reportType === REPORT_TYPES.PLANNING
        ? collectPlanningReportData(fastify, organizationId, weekStart)
        : collectExecutiveReportData(fastify, organizationId, weekStart);
}

/**
 * `true` si el objeto de datos tiene contenido sustantivo. Se usa para
 * saltar la llamada al LLM en semanas sin actividad (B.3): no hay nada que
 * redactar, y evitarla ahorra tokens BYOK del cliente sin arriesgar una
 * alucinación sobre datos vacíos.
 */
export function hasReportActivity(reportType: ReportType, data: ReportData): boolean {
    if (reportType === REPORT_TYPES.PLANNING) {
        const d = data as PlanningReportData;
        return (
            d.appointmentsByDay.length > 0 ||
            d.hotLeadsPending.length > 0 ||
            d.overdueFollowups.length > 0 ||
            d.stalledContacts.length > 0
        );
    }
    const d = data as ExecutiveReportData;
    return (d.totals?.conversations?.current ?? 0) > 0 || (d.totals?.appointmentsBooked?.current ?? 0) > 0 || d.byChannel.length > 0;
}
