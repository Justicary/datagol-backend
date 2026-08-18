import { FastifyInstance } from 'fastify';
import { DEFAULT_REPORTS_SETTINGS, type OrganizationReportsSettings, type ReportScheduleSettings } from '../types/reports.js';

/**
 * Lee `integration_settings.reports`, mergeada con los defaults (lunes 6:00
 * planificación / viernes 18:00 ejecutivo, solo correo) — nunca lanza, nunca
 * devuelve `undefined` en un campo. Único punto de lectura de esta
 * configuración: usado tanto por el orquestador (weekly-report-service.ts)
 * como por la ruta de configuración (routes/organization-reports.ts).
 */
export async function getReportsSettings(fastify: FastifyInstance, organizationId: string): Promise<OrganizationReportsSettings> {
    const { data: org } = await fastify.supabaseAdmin
        .from('organizations')
        .select('integration_settings')
        .eq('id', organizationId)
        .maybeSingle();

    const raw = ((org?.integration_settings as Record<string, unknown>)?.reports ?? {}) as Partial<OrganizationReportsSettings>;

    return {
        planning: { ...DEFAULT_REPORTS_SETTINGS.planning, ...(raw.planning ?? {}) } as ReportScheduleSettings,
        executive: { ...DEFAULT_REPORTS_SETTINGS.executive, ...(raw.executive ?? {}) } as ReportScheduleSettings,
        whatsappTemplateName: raw.whatsappTemplateName ?? null,
        whatsappRecipientPhone: raw.whatsappRecipientPhone ?? null,
    };
}
