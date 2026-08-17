import { FastifyInstance } from 'fastify';
import { getSecret } from './secret-service.js';
import { getRate } from './rate-service.js';
import { SECRET_KEYS } from '../types/secret-keys.js';
import { USAGE_EVENT_PROVIDERS } from '../types/usage-event-provider.js';

export interface SendThankYouWhatsAppParams {
    organizationId: string;
    contactId: string;
    phoneE164: string;
    prospectName?: string | null;
    businessName?: string | null;
    customBody?: string | null;
    whatsappTemplateName?: string | null;
    attachmentDownloadUrl?: string | null;
}

export interface SendThankYouWhatsAppResult {
    sent: boolean;
    skipReason?: string | null;
    waMessageId?: string | null;
    error?: string | null;
}

/**
 * Determina si el contacto ha enviado un mensaje entrante en las últimas 24 horas.
 */
export async function isWithinWhatsApp24hWindow(
    fastify: FastifyInstance,
    organizationId: string,
    contactId: string
): Promise<boolean> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { count, error } = await fastify.supabaseAdmin
        .from('whatsapp_messages')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('contact_id', contactId)
        .eq('direction', 'inbound')
        .gte('created_at', twentyFourHoursAgo);

    if (error) {
        fastify.log.warn({ error, organizationId, contactId }, '[WhatsApp] Error verificando ventana de 24h');
        return false;
    }

    return (count ?? 0) > 0;
}

/**
 * Despacha el mensaje de agradecimiento por WhatsApp respetando la ventana de Meta.
 */
export async function sendThankYouWhatsApp(
    fastify: FastifyInstance,
    params: SendThankYouWhatsAppParams
): Promise<SendThankYouWhatsAppResult> {
    const {
        organizationId,
        contactId,
        phoneE164,
        prospectName,
        businessName = 'nuestro equipo',
        customBody,
        whatsappTemplateName,
        attachmentDownloadUrl,
    } = params;

    // 1. Obtener credenciales de WhatsApp de la organización
    const { data: org, error: orgError } = await fastify.supabaseAdmin
        .from('organizations')
        .select('whatsapp_phone_number_id, name')
        .eq('id', organizationId)
        .maybeSingle();

    if (orgError || !org?.whatsapp_phone_number_id) {
        fastify.log.warn({ organizationId }, '[WhatsApp] Organización sin whatsapp_phone_number_id');
        return { sent: false, skipReason: 'sin_configuracion_whatsapp' };
    }

    const accessToken = await getSecret(organizationId, SECRET_KEYS.WHATSAPP_ACCESS_TOKEN);
    if (!accessToken) {
        fastify.log.warn({ organizationId }, '[WhatsApp] Organización sin WHATSAPP_ACCESS_TOKEN');
        return { sent: false, skipReason: 'sin_credenciales_whatsapp' };
    }

    // 2. Verificar ventana de servicio de 24 horas
    const withinWindow = await isWithinWhatsApp24hWindow(fastify, organizationId, contactId);

    const displayName = org.name || businessName;
    const cleanPhone = phoneE164.replace(/[^0-9]/g, '');

    // Formatear mensaje libre
    let messageBody =
        customBody ||
        `¡Hola${prospectName ? ` ${prospectName}` : ''}! Gracias por comunicarte con ${displayName}. Hemos recibido tus datos y en breve te atenderemos.`;

    if (attachmentDownloadUrl) {
        messageBody += `\n\n📄 Puedes descargar la información adicional aquí: ${attachmentDownloadUrl}`;
    }

    let payload: Record<string, unknown>;
    let unitType = 'wa_service_mx';

    if (withinWindow) {
        // Mensaje libre dentro de la ventana de 24h
        payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'text',
            text: { body: messageBody },
        };
    } else {
        // Fuera de ventana: requiere plantilla aprobada por Meta
        if (!whatsappTemplateName || whatsappTemplateName.trim() === '') {
            fastify.log.info(
                { organizationId, contactId },
                '[WhatsApp] Fuera de ventana de 24h sin plantilla configurada; se omite deliberadamente'
            );
            return { sent: false, skipReason: 'sin_plantilla_aprobada_fuera_de_ventana' };
        }

        unitType = 'wa_utility_mx'; // Default de plantilla de servicio/utilidad
        payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'template',
            template: {
                name: whatsappTemplateName,
                language: { code: 'es_MX' },
            },
        };
    }

    // 3. Envío HTTP a Meta Graph API
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
            fastify.log.error({ errMsg, organizationId, contactId }, '[WhatsApp] Meta Graph API retornó error');
            return { sent: false, error: errMsg };
        }

        const waMessageId = resData.messages?.[0]?.id || `wa-${Date.now()}`;

        // 4. Registrar mensaje en whatsapp_messages
        await fastify.supabaseAdmin.from('whatsapp_messages').insert({
            organization_id: organizationId,
            contact_id: contactId,
            direction: 'outbound',
            body: withinWindow ? messageBody : `[Plantilla: ${whatsappTemplateName}]`,
            wa_message_id: waMessageId,
            status: 'sent',
        });

        // 5. Registrar consumo en usage_events si aplica
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
                    idempotency_key: `wa-thank-you:${waMessageId}`,
                    metadata: {
                        contact_id: contactId,
                        template_name: withinWindow ? null : whatsappTemplateName,
                    },
                });
            }
        } catch (meteringErr) {
            fastify.log.warn({ meteringErr, organizationId }, '[WhatsApp] Falló el registro de consumo en usage_events');
        }

        fastify.log.info({ organizationId, contactId, waMessageId }, '[WhatsApp] Agradecimiento por WhatsApp entregado con éxito');
        return { sent: true, waMessageId };
    } catch (fetchErr: any) {
        fastify.log.error({ fetchErr, organizationId, contactId }, '[WhatsApp] Excepción al enviar mensaje a Meta');
        return { sent: false, error: fetchErr.message };
    }
}
