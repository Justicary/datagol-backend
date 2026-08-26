import { FastifyInstance } from 'fastify';
import { getSecret } from './secret-service.js';
import { getRate } from './rate-service.js';
import { SECRET_KEYS } from '../types/secret-keys.js';
import { USAGE_EVENT_PROVIDERS } from '../types/usage-event-provider.js';
import { isWithinWhatsApp24hWindow } from './thank-you-whatsapp.js';

export interface SendWaitlistOfferWhatsAppParams {
    organizationId: string;
    contactId: string | null;
    phoneE164: string;
    customerName: string;
    businessName: string;
    confirmationUrl: string;
    slotDescription: string;
}

export interface SendWaitlistOfferWhatsAppResult {
    sent: boolean;
    skipReason?: string | null;
    waMessageId?: string | null;
    error?: string | null;
}

/**
 * Envía la oferta de cupo liberado por WhatsApp con el enlace de
 * confirmación de un clic (docs/tasks/waitlist_confirmacion_masiva.md,
 * Tarea B3). Hermana de `sendThankYouWhatsApp` — misma ventana de servicio
 * de 24h de Meta, mismo registro en `whatsapp_messages`/`usage_events` — mas
 * no se fusiona con ella: el mensaje libre y la plantilla llevan aquí el
 * enlace dinámico como variable, algo que `sendThankYouWhatsApp` no necesita.
 *
 * Fuera de la ventana de 24h, Meta exige una plantilla aprobada con
 * EXACTAMENTE una variable de cuerpo (el enlace) — configurada por la
 * organización en `integration_settings.waitlist_whatsapp_template_name`.
 * Sin esa plantilla configurada, el llamador (`waitlist-engine.ts`) debe
 * tratar esto como "WhatsApp no viable" y degradar a voz, no reintentar.
 */
export async function sendWaitlistOfferWhatsApp(
    fastify: FastifyInstance,
    params: SendWaitlistOfferWhatsAppParams
): Promise<SendWaitlistOfferWhatsAppResult> {
    const { organizationId, contactId, phoneE164, customerName, businessName, confirmationUrl, slotDescription } = params;

    const { data: org, error: orgError } = await fastify.supabaseAdmin
        .from('organizations')
        .select('whatsapp_phone_number_id, integration_settings')
        .eq('id', organizationId)
        .maybeSingle();

    if (orgError || !org?.whatsapp_phone_number_id) {
        return { sent: false, skipReason: 'sin_configuracion_whatsapp' };
    }

    const templateName = (org.integration_settings as Record<string, unknown> | null)?.waitlist_whatsapp_template_name;
    const accessToken = await getSecret(organizationId, SECRET_KEYS.WHATSAPP_ACCESS_TOKEN);
    if (!accessToken) {
        return { sent: false, skipReason: 'sin_credenciales_whatsapp' };
    }

    const withinWindow = contactId ? await isWithinWhatsApp24hWindow(fastify, organizationId, contactId) : false;
    const cleanPhone = phoneE164.replace(/[^0-9]/g, '');

    let payload: Record<string, unknown>;
    let unitType = 'wa_service_mx';

    if (withinWindow) {
        payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'text',
            text: {
                body: `¡Hola ${customerName}! Se liberó un cupo en ${businessName} para ${slotDescription}. Confirma o rechaza aquí: ${confirmationUrl}`,
            },
        };
    } else {
        if (typeof templateName !== 'string' || templateName.trim() === '') {
            fastify.log.info(
                { organizationId, contactId },
                '[Waitlist WhatsApp] Fuera de ventana de 24h sin plantilla configurada; se omite deliberadamente'
            );
            return { sent: false, skipReason: 'sin_plantilla_aprobada_fuera_de_ventana' };
        }

        unitType = 'wa_utility_mx';
        payload = {
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
                        parameters: [{ type: 'text', text: confirmationUrl }],
                    },
                ],
            },
        };
    }

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

        const resData = (await response.json()) as any;

        if (!response.ok || resData.error) {
            const errMsg = resData.error?.message || response.statusText;
            fastify.log.error({ errMsg, organizationId, contactId }, '[Waitlist WhatsApp] Meta Graph API retornó error');
            return { sent: false, error: errMsg };
        }

        const waMessageId = resData.messages?.[0]?.id || `wa-waitlist-${Date.now()}`;

        await fastify.supabaseAdmin.from('whatsapp_messages').insert({
            organization_id: organizationId,
            contact_id: contactId,
            direction: 'outbound',
            body: withinWindow ? (payload.text as { body: string }).body : `[Plantilla: ${templateName}]`,
            wa_message_id: waMessageId,
            status: 'sent',
        });

        try {
            const now = new Date();
            const rate = await getRate(fastify, USAGE_EVENT_PROVIDERS.META, unitType, now);
            if (rate && rate.unitRateUsd > 0) {
                await fastify.supabaseAdmin.from('usage_events').insert({
                    organization_id: organizationId,
                    provider: USAGE_EVENT_PROVIDERS.META,
                    unit_type: unitType,
                    quantity: 1,
                    unit_rate_usd: rate.unitRateUsd,
                    amount_usd: rate.unitRateUsd,
                    occurred_at: now.toISOString(),
                    idempotency_key: `wa-waitlist-offer:${waMessageId}`,
                    metadata: { contact_id: contactId, template_name: withinWindow ? null : templateName },
                });
            }
        } catch (meteringErr) {
            fastify.log.warn({ meteringErr, organizationId }, '[Waitlist WhatsApp] Falló el registro de consumo en usage_events');
        }

        fastify.log.info({ organizationId, contactId, waMessageId }, '[Waitlist WhatsApp] Oferta entregada correctamente');
        return { sent: true, waMessageId };
    } catch (fetchErr: any) {
        fastify.log.error({ fetchErr, organizationId, contactId }, '[Waitlist WhatsApp] Excepción al enviar mensaje a Meta');
        return { sent: false, error: fetchErr.message };
    }
}
