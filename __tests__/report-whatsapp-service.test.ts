import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendWeeklyReportWhatsApp } from '../src/services/report-whatsapp-service.js';
import * as secretService from '../src/services/secret-service.js';
import * as rateService from '../src/services/rate-service.js';
import { REPORT_TYPES } from '../src/types/reports.js';

function buildFakeFastify(org: { whatsapp_phone_number_id?: string | null } | null) {
    const usageInserts: Record<string, unknown>[] = [];
    const fastify: any = {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        supabaseAdmin: {
            from: vi.fn((table: string) => {
                if (table === 'organizations') {
                    return {
                        select: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                maybeSingle: vi.fn().mockResolvedValue({ data: org, error: null }),
                            }),
                        }),
                    };
                }
                if (table === 'usage_events') {
                    return {
                        insert: vi.fn().mockImplementation((rows: any) => {
                            usageInserts.push(...(Array.isArray(rows) ? rows : [rows]));
                            return Promise.resolve({ error: null });
                        }),
                    };
                }
                return {};
            }),
        },
    };
    return { fastify, usageInserts };
}

describe('services/report-whatsapp-service.ts', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('sin whatsapp_phone_number_id: se omite con razón explícita', async () => {
        const { fastify } = buildFakeFastify({ whatsapp_phone_number_id: null });
        const result = await sendWeeklyReportWhatsApp(fastify, {
            organizationId: 'org-1',
            reportType: REPORT_TYPES.EXECUTIVE,
            phoneE164: '+525512345678',
            templateName: 'reporte_semanal',
            headline: 'Titular de prueba',
        });
        expect(result).toEqual({ sent: false, skipReason: 'sin_configuracion_whatsapp' });
    });

    it('sin WHATSAPP_ACCESS_TOKEN: se omite con razón explícita', async () => {
        const { fastify } = buildFakeFastify({ whatsapp_phone_number_id: '123456' });
        vi.spyOn(secretService, 'getSecret').mockResolvedValue(null);

        const result = await sendWeeklyReportWhatsApp(fastify, {
            organizationId: 'org-1',
            reportType: REPORT_TYPES.EXECUTIVE,
            phoneE164: '+525512345678',
            templateName: 'reporte_semanal',
            headline: 'Titular de prueba',
        });
        expect(result).toEqual({ sent: false, skipReason: 'sin_credenciales_whatsapp' });
    });

    it('contraparte de éxito: envía la plantilla con components/parameters y registra el consumo', async () => {
        const { fastify, usageInserts } = buildFakeFastify({ whatsapp_phone_number_id: '123456' });
        vi.spyOn(secretService, 'getSecret').mockResolvedValue('wa-token');
        vi.spyOn(rateService, 'getRate').mockResolvedValue({ unitRateUsd: 0.008 } as any);

        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ messages: [{ id: 'wamid.TEST123' }] }),
        } as any);

        const result = await sendWeeklyReportWhatsApp(fastify, {
            organizationId: 'org-1',
            reportType: REPORT_TYPES.EXECUTIVE,
            phoneE164: '+525512345678',
            templateName: 'reporte_semanal',
            headline: '5 conversaciones esta semana',
        });

        expect(result.sent).toBe(true);
        expect(result.waMessageId).toBe('wamid.TEST123');

        const fetchCall = vi.mocked(global.fetch).mock.calls[0];
        const requestBody = JSON.parse(fetchCall[1]?.body as string);
        expect(requestBody.type).toBe('template');
        expect(requestBody.template.name).toBe('reporte_semanal');
        expect(requestBody.template.components[0].type).toBe('body');
        expect(requestBody.template.components[0].parameters).toHaveLength(2);
        expect(requestBody.template.components[0].parameters[1]).toEqual({ type: 'text', text: '5 conversaciones esta semana' });

        expect(usageInserts).toHaveLength(1);
        expect(usageInserts[0]).toMatchObject({ provider: 'meta', unit_type: 'wa_utility_mx' });
    });

    it('Meta Graph API retorna error: sent=false con el mensaje de error', async () => {
        const { fastify } = buildFakeFastify({ whatsapp_phone_number_id: '123456' });
        vi.spyOn(secretService, 'getSecret').mockResolvedValue('wa-token');

        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            json: () => Promise.resolve({ error: { message: 'Template not found' } }),
        } as any);

        const result = await sendWeeklyReportWhatsApp(fastify, {
            organizationId: 'org-1',
            reportType: REPORT_TYPES.PLANNING,
            phoneE164: '+525512345678',
            templateName: 'plantilla_inexistente',
            headline: 'x',
        });

        expect(result.sent).toBe(false);
        expect(result.error).toBe('Template not found');
    });

    it('excepción de red: sent=false sin lanzar', async () => {
        const { fastify } = buildFakeFastify({ whatsapp_phone_number_id: '123456' });
        vi.spyOn(secretService, 'getSecret').mockResolvedValue('wa-token');
        global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

        const result = await sendWeeklyReportWhatsApp(fastify, {
            organizationId: 'org-1',
            reportType: REPORT_TYPES.PLANNING,
            phoneE164: '+525512345678',
            templateName: 'reporte_semanal',
            headline: 'x',
        });

        expect(result.sent).toBe(false);
        expect(result.error).toContain('fetch failed');
    });
});
