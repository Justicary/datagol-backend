import type { FastifyInstance } from 'fastify';
import { getSecret } from '../secret-service.js';
import { getRate } from '../rate-service.js';
import { isFeatureEnabled } from '../entitlements.js';
import { isWithinWhatsApp24hWindow } from '../thank-you-whatsapp.js';
import { normalizePhoneE164 } from '../phone-normalization.js';
import { SECRET_KEYS } from '../../types/secret-keys.js';
import { FEATURE_KEYS } from '../../types/feature-taxonomy.js';
import { USAGE_EVENT_PROVIDERS } from '../../types/usage-event-provider.js';

export interface SendQuotationWhatsAppParams {
    organizationId: string;
    quotationId: string;
    contactId: string | null;
    phoneRaw: string;
    folio: string;
    totalFormatted: string;
    signedPdfUrl: string;
    customerName?: string | null;
    businessName?: string | null;
    whatsappTemplateName?: string | null;
    contactOptedOut?: boolean;
}

export interface SendQuotationWhatsAppResult {
    sent: boolean;
    skipReason?: string | null;
    waMessageId?: string | null;
    error?: string | null;
}

interface MetaMessagesResponse {
    messages?: Array<{ id?: string }>;
    error?: { message?: string };
}

/**
 * Envía una cotización en PDF por WhatsApp (H7, Fase F):
 * - Verifica feature `whatsapp`, E.164 válido, `!opted_out` y credenciales.
 * - Dentro de ventana de 24h: envía mensaje `type: 'document'` con `filename = {folio}.pdf` y `caption`.
 * - Fuera de ventana de 24h: usa plantilla con cabecera de documento si `whatsappTemplateName` está configurada,
 *   o devuelve `skipReason: 'fuera_de_ventana_sin_plantilla'`.
 * - Registra en `whatsapp_messages` y en `usage_events` con `idempotency_key = 'wa-quotation:{waMessageId}'`.
 */
export async function sendQuotationWhatsApp(
    fastify: FastifyInstance,
    params: SendQuotationWhatsAppParams
): Promise<SendQuotationWhatsAppResult> {
    const {
        organizationId,
        quotationId,
        contactId,
        phoneRaw,
        folio,
        totalFormatted,
        signedPdfUrl,
        customerName,
        businessName,
        whatsappTemplateName,
        contactOptedOut,
    } = params;

    // 1. Verificar feature `whatsapp` (§16)
    const waEnabled = await isFeatureEnabled(organizationId, FEATURE_KEYS.WHATSAPP);
    if (!waEnabled) {
        return { sent: false, skipReason: 'whatsapp_feature_deshabilitada' };
    }

    // 2. Validar teléfono E.164 antes de cualquier llamada de red
    const normalizedPhone = normalizePhoneE164(phoneRaw);
    if (!normalizedPhone.success || !normalizedPhone.phoneE164) {
        return { sent: false, skipReason: 'telefono_e164_invalido' };
    }

    // 3. Verificar opt-out del contacto
    if (contactOptedOut === true) {
        return { sent: false, skipReason: 'contacto_opted_out' };
    }
    if (contactOptedOut === undefined && contactId) {
        const { data: contactRow } = await fastify.supabaseAdmin
            .from('contacts')
            .select('opted_out')
            .eq('id', contactId)
            .eq('organization_id', organizationId)
            .maybeSingle();

        if (contactRow?.opted_out) {
            return { sent: false, skipReason: 'contacto_opted_out' };
        }
    }

    // 4. Obtener credenciales de WhatsApp de la organización
    const { data: org, error: orgError } = await fastify.supabaseAdmin
        .from('organizations')
        .select('whatsapp_phone_number_id, name')
        .eq('id', organizationId)
        .maybeSingle();

    if (orgError || !org?.whatsapp_phone_number_id) {
        fastify.log.warn({ organizationId, quotationId }, '[QuotationWhatsApp] Organización sin whatsapp_phone_number_id');
        return { sent: false, skipReason: 'sin_configuracion_whatsapp' };
    }

    const accessToken = await getSecret(organizationId, SECRET_KEYS.WHATSAPP_ACCESS_TOKEN);
    if (!accessToken) {
        fastify.log.warn({ organizationId, quotationId }, '[QuotationWhatsApp] Organización sin WHATSAPP_ACCESS_TOKEN');
        return { sent: false, skipReason: 'sin_credenciales_whatsapp' };
    }

    // 5. Determinar ventana de 24 horas
    const withinWindow = contactId
        ? await isWithinWhatsApp24hWindow(fastify, organizationId, contactId)
        : false;

    const displayName = org.name || businessName || 'nuestro equipo';
    const cleanPhone = normalizedPhone.phoneE164.replace(/[^0-9]/g, '');
    const filename = `${folio}.pdf`;
    const caption = `📄 Cotización ${folio} de ${displayName} — Total inicial: ${totalFormatted}.`;

    let payload: Record<string, unknown>;
    let unitType = 'wa_service_mx';

    if (withinWindow) {
        payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'document',
            document: {
                link: signedPdfUrl,
                filename,
                caption,
            },
        };
    } else {
        const trimmedTemplate = whatsappTemplateName?.trim() ?? '';
        if (!trimmedTemplate) {
            fastify.log.info(
                { organizationId, quotationId, contactId },
                '[QuotationWhatsApp] Fuera de ventana de 24h sin plantilla configurada; se omite deliberadamente'
            );
            return { sent: false, skipReason: 'fuera_de_ventana_sin_plantilla' };
        }

        unitType = 'wa_utility_mx';
        payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'template',
            template: {
                name: trimmedTemplate,
                language: { code: 'es_MX' },
                components: [
                    {
                        type: 'header',
                        parameters: [
                            {
                                type: 'document',
                                document: {
                                    link: signedPdfUrl,
                                    filename,
                                },
                            },
                        ],
                    },
                    {
                        type: 'body',
                        parameters: [
                            { type: 'text', text: customerName || 'Cliente' },
                            { type: 'text', text: folio },
                            { type: 'text', text: totalFormatted },
                        ],
                    },
                ],
            },
        };
    }

    // 6. Envío HTTP a Meta Graph API
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

        const resData = (await response.json()) as MetaMessagesResponse;

        if (!response.ok || resData.error) {
            const errMsg = resData.error?.message || response.statusText || 'Error HTTP de Meta';
            fastify.log.error(
                { errMsg, organizationId, quotationId, contactId },
                '[QuotationWhatsApp] Meta Graph API retornó error'
            );
            return { sent: false, error: errMsg };
        }

        const waMessageId = resData.messages?.[0]?.id || `wa-quot-${quotationId}`;

        // 7. Registrar mensaje en whatsapp_messages
        if (contactId) {
            await fastify.supabaseAdmin.from('whatsapp_messages').insert({
                organization_id: organizationId,
                contact_id: contactId,
                direction: 'outbound',
                body: withinWindow ? caption : `[Plantilla Cotización: ${whatsappTemplateName?.trim()}] ${folio}`,
                wa_message_id: waMessageId,
                status: 'sent',
            });
        }

        // 8. Metering en usage_events (AGENTS.md §6) con clave de idempotencia única
        try {
            const now = new Date();
            const rate = await getRate(fastify, USAGE_EVENT_PROVIDERS.META, unitType, now);
            if (rate && rate.unitRateUsd > 0) {
                const { error: meteringError } = await fastify.supabaseAdmin.from('usage_events').insert({
                    organization_id: organizationId,
                    provider: USAGE_EVENT_PROVIDERS.META,
                    unit_type: unitType,
                    quantity: 1,
                    unit_rate_usd: rate.unitRateUsd,
                    occurred_at: now.toISOString(),
                    idempotency_key: `wa-quotation:${waMessageId}`,
                    metadata: {
                        quotation_id: quotationId,
                        folio,
                        contact_id: contactId,
                        template_name: withinWindow ? null : whatsappTemplateName?.trim() ?? null,
                    },
                });
                if (meteringError && meteringError.code !== '23505') {
                    fastify.log.warn(
                        { err: meteringError.message, organizationId, quotationId },
                        '[QuotationWhatsApp] Falló el registro de consumo en usage_events'
                    );
                }
            }
        } catch (meteringErr) {
            fastify.log.warn(
                { meteringErr, organizationId, quotationId },
                '[QuotationWhatsApp] Excepción registrando consumo en usage_events'
            );
        }

        fastify.log.info(
            { organizationId, quotationId, contactId, waMessageId, folio },
            '[QuotationWhatsApp] Cotización enviada por WhatsApp con éxito'
        );
        return { sent: true, waMessageId };
    } catch (fetchErr: unknown) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        fastify.log.error({ err: msg, organizationId, quotationId, contactId }, '[QuotationWhatsApp] Excepción al enviar a Meta');
        return { sent: false, error: msg };
    }
}
