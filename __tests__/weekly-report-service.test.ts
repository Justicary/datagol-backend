import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateAndDeliverWeeklyReport } from '../src/services/weekly-report-service.js';
import * as reportDataService from '../src/services/report-data-service.js';
import * as reportGenerationService from '../src/services/report-generation-service.js';
import * as reportStorageService from '../src/services/report-storage-service.js';
import * as emailService from '../src/services/email.js';
import * as reportWhatsAppService from '../src/services/report-whatsapp-service.js';
import * as entitlementsService from '../src/services/entitlements.js';
import { REPORT_TYPES, REPORT_STATUSES } from '../src/types/reports.js';
import type { PlanningReportData, ExecutiveReportData } from '../src/services/report-data-service.js';

const SAMPLE_PLANNING_DATA: PlanningReportData = {
    weekStart: '2026-08-10',
    weekEnd: '2026-08-16',
    appointmentsByDay: [],
    unconfirmedAppointments: [],
    hotLeadsPending: [
        {
            lead_id: 'lead-1',
            full_name: 'Juan Pérez',
            phone_e164: '+525512345678',
            business_name: null,
            inquiry_reason: 'Cotización de servicio',
            created_at: '2026-08-11T10:00:00.000Z',
        },
    ],
    overdueFollowups: [],
    stalledContacts: [],
    dailyLoad: [],
    agendaGapsMinutes: null,
};

const SAMPLE_EXECUTIVE_DATA: ExecutiveReportData = {
    weekStart: '2026-08-10',
    weekEnd: '2026-08-16',
    totals: {
        conversations: { current: 5, previous: 3 },
        appointmentsBooked: { current: 2, previous: 1 },
    },
    byChannel: [],
    lostProspects: [],
    pipelineMovement: [],
    recurringTopics: [],
    costUsd: { totalUsd: 1.5, perProspectUsd: 0.3 },
    alerts: { avgCallDurationSeconds: null, baselineAvgCallDurationSeconds: null, isDurationAnomalous: false, llmCredentialError: null },
};

interface FakeOrgRow {
    name: string;
    email: string | null;
    phone_number: string | null;
    integration_settings: Record<string, unknown>;
}

function buildFakeFastify(org: FakeOrgRow, claimSucceeds = true) {
    const weeklyReportUpdates: Record<string, unknown>[] = [];
    let claimed = false;

    const fastify: any = {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        supabaseAdmin: {
            from: vi.fn((table: string) => {
                if (table === 'weekly_reports') {
                    return {
                        insert: vi.fn().mockReturnValue({
                            select: vi.fn().mockReturnValue({
                                maybeSingle: vi.fn().mockImplementation(() => {
                                    if (!claimSucceeds || claimed) {
                                        return Promise.resolve({
                                            data: null,
                                            error: { code: '23505', message: 'duplicate key' },
                                        });
                                    }
                                    claimed = true;
                                    return Promise.resolve({ data: { id: 'report-1' }, error: null });
                                }),
                            }),
                        }),
                        update: vi.fn((payload: any) => ({
                            eq: vi.fn().mockImplementation(() => {
                                weeklyReportUpdates.push(payload);
                                return Promise.resolve({ error: null });
                            }),
                        })),
                    };
                }
                if (table === 'organizations') {
                    return {
                        select: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                maybeSingle: vi.fn().mockResolvedValue({ data: org, error: null }),
                            }),
                        }),
                    };
                }
                return {};
            }),
        },
    };

    return { fastify, weeklyReportUpdates };
}

describe('services/weekly-report-service.ts — generateAndDeliverWeeklyReport', () => {
    beforeEach(() => {
        vi.spyOn(entitlementsService, 'getOrganizationFeatures').mockResolvedValue(new Set(['weekly_planning_report', 'weekly_executive_report']));
        vi.spyOn(reportDataService, 'collectReportData').mockResolvedValue(SAMPLE_PLANNING_DATA);
        vi.spyOn(reportGenerationService, 'generateReportNarrative').mockResolvedValue({
            narrative: 'Reporte de prueba.',
            recommendations: ['Recomendación 1'],
            usedFallback: false,
        });
        vi.spyOn(reportStorageService, 'uploadWeeklyReportHtml').mockResolvedValue({ storagePath: 'org-1/planning/2026-08-10.html', sizeBytes: 1234 });
        vi.spyOn(reportStorageService, 'generateReportSignedUrl').mockResolvedValue('https://signed.example/report.html');
        vi.spyOn(emailService, 'resolveOrganizationEmailOptions').mockResolvedValue({});
        vi.spyOn(emailService, 'sendWeeklyReportEmail').mockResolvedValue({ data: { id: 'email-1' } } as any);
        vi.spyOn(reportWhatsAppService, 'sendWeeklyReportWhatsApp').mockResolvedValue({ sent: true, waMessageId: 'wamid.1' });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('idempotencia: si el slot semanal ya existe (23505), no genera nada más', async () => {
        const { fastify } = buildFakeFastify(
            { name: 'Negocio', email: 'admin@negocio.com', phone_number: null, integration_settings: {} },
            false
        );

        const result = await generateAndDeliverWeeklyReport(fastify, {
            organizationId: 'org-1',
            reportType: REPORT_TYPES.PLANNING,
            weekStart: '2026-08-10',
        });

        expect(result.claimed).toBe(false);
        expect(reportDataService.collectReportData).not.toHaveBeenCalled();
    });

    it('feature no habilitada al momento de generar: no recolecta datos, finaliza como failed', async () => {
        vi.spyOn(entitlementsService, 'getOrganizationFeatures').mockResolvedValue(new Set());
        const { fastify, weeklyReportUpdates } = buildFakeFastify({
            name: 'Negocio',
            email: 'admin@negocio.com',
            phone_number: null,
            integration_settings: {},
        });

        const result = await generateAndDeliverWeeklyReport(fastify, {
            organizationId: 'org-1',
            reportType: REPORT_TYPES.PLANNING,
            weekStart: '2026-08-10',
        });

        expect(result.status).toBe(REPORT_STATUSES.FAILED);
        expect(reportDataService.collectReportData).not.toHaveBeenCalled();
        expect(weeklyReportUpdates[0]).toMatchObject({ status: REPORT_STATUSES.FAILED });
    });

    it('contraparte de éxito: solo canal correo — genera, sube a Storage, envía y finaliza como generated', async () => {
        const { fastify, weeklyReportUpdates } = buildFakeFastify({
            name: 'Negocio',
            email: 'admin@negocio.com',
            phone_number: null,
            integration_settings: { reports: { planning: { enabled: true, dayOfWeek: 1, hour: 6, channels: ['email'] } } },
        });

        const result = await generateAndDeliverWeeklyReport(fastify, {
            organizationId: 'org-1',
            reportType: REPORT_TYPES.PLANNING,
            weekStart: '2026-08-10',
        });

        expect(result.claimed).toBe(true);
        expect(result.status).toBe(REPORT_STATUSES.GENERATED);
        expect(emailService.sendWeeklyReportEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'admin@negocio.com' }));
        expect(reportWhatsAppService.sendWeeklyReportWhatsApp).not.toHaveBeenCalled();

        const finalUpdate = weeklyReportUpdates[weeklyReportUpdates.length - 1];
        expect(finalUpdate).toMatchObject({ status: REPORT_STATUSES.GENERATED, storage_path: 'org-1/planning/2026-08-10.html' });
        expect((finalUpdate as any).delivery_log.email).toMatchObject({ status: 'sent' });
    });

    it('narrativa con fallback: el estado final es narrative_fallback', async () => {
        vi.spyOn(reportGenerationService, 'generateReportNarrative').mockResolvedValue({
            narrative: null,
            recommendations: [],
            usedFallback: true,
        });
        const { fastify } = buildFakeFastify({
            name: 'Negocio',
            email: 'admin@negocio.com',
            phone_number: null,
            integration_settings: { reports: { planning: { enabled: true, dayOfWeek: 1, hour: 6, channels: ['email'] } } },
        });

        const result = await generateAndDeliverWeeklyReport(fastify, {
            organizationId: 'org-1',
            reportType: REPORT_TYPES.PLANNING,
            weekStart: '2026-08-10',
        });

        expect(result.status).toBe(REPORT_STATUSES.NARRATIVE_FALLBACK);
    });

    it('semana sin actividad: el estado final es skipped_no_activity, sin dejar de entregar el correo', async () => {
        vi.spyOn(reportDataService, 'collectReportData').mockResolvedValue({
            weekStart: '2026-08-10',
            weekEnd: '2026-08-16',
            appointmentsByDay: [],
            unconfirmedAppointments: [],
            hotLeadsPending: [],
            overdueFollowups: [],
            stalledContacts: [],
            dailyLoad: [],
            agendaGapsMinutes: null,
        });
        vi.spyOn(reportGenerationService, 'generateReportNarrative').mockResolvedValue({
            narrative: 'Esta semana no hubo actividad registrada.',
            recommendations: [],
            usedFallback: false,
        });
        const { fastify } = buildFakeFastify({
            name: 'Negocio',
            email: 'admin@negocio.com',
            phone_number: null,
            integration_settings: { reports: { planning: { enabled: true, dayOfWeek: 1, hour: 6, channels: ['email'] } } },
        });

        const result = await generateAndDeliverWeeklyReport(fastify, {
            organizationId: 'org-1',
            reportType: REPORT_TYPES.PLANNING,
            weekStart: '2026-08-10',
        });

        expect(result.status).toBe(REPORT_STATUSES.SKIPPED_NO_ACTIVITY);
        expect(emailService.sendWeeklyReportEmail).toHaveBeenCalledOnce();
    });

    it('WhatsApp sin plantilla configurada: se omite con razón explícita y no llama al servicio de WhatsApp', async () => {
        vi.spyOn(reportDataService, 'collectReportData').mockResolvedValue(SAMPLE_EXECUTIVE_DATA);
        const { fastify, weeklyReportUpdates } = buildFakeFastify({
            name: 'Negocio',
            email: 'admin@negocio.com',
            phone_number: '+525512345678',
            integration_settings: {
                reports: { executive: { enabled: true, dayOfWeek: 5, hour: 18, channels: ['email', 'whatsapp'] } },
            },
        });

        await generateAndDeliverWeeklyReport(fastify, {
            organizationId: 'org-1',
            reportType: REPORT_TYPES.EXECUTIVE,
            weekStart: '2026-08-10',
        });

        expect(reportWhatsAppService.sendWeeklyReportWhatsApp).not.toHaveBeenCalled();
        const finalUpdate = weeklyReportUpdates[weeklyReportUpdates.length - 1] as any;
        expect(finalUpdate.delivery_log.whatsapp).toEqual({ status: 'omitted', reason: 'sin_plantilla_configurada' });
    });

    it('entrega dual: con ambos canales y plantilla configurada, WhatsApp y correo se envían', async () => {
        vi.spyOn(reportDataService, 'collectReportData').mockResolvedValue(SAMPLE_EXECUTIVE_DATA);
        const { fastify, weeklyReportUpdates } = buildFakeFastify({
            name: 'Negocio',
            email: 'admin@negocio.com',
            phone_number: '+525512345678',
            integration_settings: {
                reports: {
                    executive: { enabled: true, dayOfWeek: 5, hour: 18, channels: ['email', 'whatsapp'] },
                    whatsappTemplateName: 'reporte_semanal',
                },
            },
        });

        const result = await generateAndDeliverWeeklyReport(fastify, {
            organizationId: 'org-1',
            reportType: REPORT_TYPES.EXECUTIVE,
            weekStart: '2026-08-10',
        });

        expect(result.status).toBe(REPORT_STATUSES.GENERATED);
        expect(emailService.sendWeeklyReportEmail).toHaveBeenCalledOnce();
        expect(reportWhatsAppService.sendWeeklyReportWhatsApp).toHaveBeenCalledWith(
            fastify,
            expect.objectContaining({ templateName: 'reporte_semanal', phoneE164: '+525512345678' })
        );

        const finalUpdate = weeklyReportUpdates[weeklyReportUpdates.length - 1] as any;
        expect(finalUpdate.delivery_log.email).toMatchObject({ status: 'sent' });
        expect(finalUpdate.delivery_log.whatsapp).toMatchObject({ status: 'sent' });
    });
});
