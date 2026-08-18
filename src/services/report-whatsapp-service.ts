import { FastifyInstance } from 'fastify';
import { getSecret } from './secret-service.js';
import { getRate } from './rate-service.js';
import { SECRET_KEYS } from '../types/secret-keys.js';
import { USAGE_EVENT_PROVIDERS } from '../types/usage-event-provider.js';
import { REPORT_TYPES, type ReportType } from '../types/reports.js';

export interface SendWeeklyReportWhatsAppParams {
    organizationId: string;
    reportType: ReportType;
    phoneE164: string;
    templateName: string;
    /** Titular corto (1-2 líneas) — el detalle completo va por correo/descarga. */
    headline: string;
}

export interface SendWeeklyReportWhatsAppResult {
    sent: boolean;
    skipReason?: string | null;
    waMessageId?: string | null;
    error?: string | null;
}

const REPORT_TYPE_LABELS: Record<ReportType, string> = {
    [REPORT_TYPES.PLANNING]: 'Reporte de planificación',
    [REPORT_TYPES.EXECUTIVE]: 'Reporte ejecutivo',
};

/**
 * Envía el resumen corto del reporte semanal por WhatsApp vía plantilla
 * aprobada de Meta CON parámetros — primer caso en el repo de una plantilla
 * con `components`/`parameters` (thank-you-whatsapp.ts solo usa plantillas
 * sin variables, porque nunca necesitó llevar datos dinámicos). La plantilla
 * configurada por el admin debe tener exactamente 2 variables de cuerpo:
 * {{1}} tipo de reporte, {{2}} titular corto. El llamador
 * (weekly-report-service.ts) decide si invocar esta función o registrar un
 * "omitido" — aquí no hay ninguna decisión de omisión, solo el envío.
 *
 * No registra en `whatsapp_messages`: esa tabla exige `contact_id` (no
 * nullable) porque su propósito es el historial de mensajería con
 * prospectos/clientes — un reporte semanal va al teléfono de un admin, no a
 * un contacto del CRM. El registro de auditoría de este envío vive en
 * `weekly_reports.delivery_log`, no aquí.
 */
export async function sendWeeklyReportWhatsApp(
    fastify: FastifyInstance,
    params: SendWeeklyReportWhatsAppParams
): Promise<SendWeeklyReportWhatsAppResult> {
    const { organizationId, reportType, phoneE164, templateName, headline } = params;

    const { data: org, error: orgError } = await fastify.supabaseAdmin
        .from('organizations')
        .select('whatsapp_phone_number_id')
        .eq('id', organizationId)
        .maybeSingle();

    if (orgError || !org?.whatsapp_phone_number_id) {
        fastify.log.warn({ organizationId }, '[ReportWhatsApp] Organización sin whatsapp_phone_number_id');
        return { sent: false, skipReason: 'sin_configuracion_whatsapp' };
    }

    const accessToken = await getSecret(organizationId, SECRET_KEYS.WHATSAPP_ACCESS_TOKEN);
    if (!accessToken) {
        fastify.log.warn({ organizationId }, '[ReportWhatsApp] Organización sin WHATSAPP_ACCESS_TOKEN');
        return { sent: false, skipReason: 'sin_credenciales_whatsapp' };
    }

    const cleanPhone = phoneE164.replace(/[^0-9]/g, '');

    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'template',
        template: {
            name: templateName,
            language: { code: 'es_MX' },
            components: [
                {
                    type: 'body',
                    parameters: [
                        { type: 'text', text: REPORT_TYPE_LABELS[reportType] },
                        { type: 'text', text: headline },
                    ],
                },
            ],
        },
    };

    try {
        const url = `https://graph.facebook.com/v21.0/${org.whatsapp_phone_number_id}/messages`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        const resData = (await response.json()) as { error?: { message?: string }; messages?: Array<{ id?: string }> };

        if (!response.ok || resData.error) {
            const errMsg = resData.error?.message || response.statusText;
            fastify.log.error({ errMsg, organizationId, reportType }, '[ReportWhatsApp] Meta Graph API retornó error');
            return { sent: false, error: errMsg };
        }

        const waMessageId = resData.messages?.[0]?.id || `wa-report-${Date.now()}`;

        try {
            const now = new Date();
            const rate = await getRate(fastify, USAGE_EVENT_PROVIDERS.META, 'wa_utility_mx', now);
            if (rate && rate.unitRateUsd > 0) {
                await fastify.supabaseAdmin.from('usage_events').insert({
                    organization_id: organizationId,
                    provider: USAGE_EVENT_PROVIDERS.META,
                    unit_type: 'wa_utility_mx',
                    quantity: 1,
                    unit_rate_usd: rate.unitRateUsd,
                    amount_usd: rate.unitRateUsd,
                    occurred_at: now.toISOString(),
                    idempotency_key: `wa-report:${waMessageId}`,
                    metadata: { reportType, templateName },
                });
            }
        } catch (meteringErr) {
            fastify.log.warn({ meteringErr, organizationId }, '[ReportWhatsApp] Falló el registro de consumo en usage_events');
        }

        fastify.log.info({ organizationId, reportType, waMessageId }, '[ReportWhatsApp] Resumen de reporte semanal entregado');
        return { sent: true, waMessageId };
    } catch (fetchErr: unknown) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        fastify.log.error({ fetchErr, organizationId, reportType }, '[ReportWhatsApp] Excepción al enviar mensaje a Meta');
        return { sent: false, error: msg };
    }
}
