import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { getOrganizationFeatures } from '../services/entitlements.js';
import { getSecret } from '../services/secret-service.js';
import { getRate } from '../services/rate-service.js';
import { isWithinWhatsApp24hWindow } from '../services/thank-you-whatsapp.js';
import { VoiceProviderFactory } from '../services/providers/VoiceProviderFactory.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { SECRET_KEYS } from '../types/secret-keys.js';
import { USAGE_EVENT_PROVIDERS } from '../types/usage-event-provider.js';
import { APPOINTMENT_STATUSES } from '../types/appointment-status.js';

export const SEND_BULK_CONFIRMATION_REQUEST_QUEUE = 'send-bulk-confirmation-request';

export interface SendBulkConfirmationRequestJobData {
    appointmentId: string;
}

const CONFIRMABLE_STATUSES: readonly string[] = [APPOINTMENT_STATUSES.PROGRAMADA, APPOINTMENT_STATUSES.CONFIRMADA];

/**
 * Notificación de confirmación masiva (docs/tasks/waitlist_confirmacion_masiva.md,
 * Tarea B4 — alcance v1 "solo notificación", decisión explícita del
 * usuario). NO incluye un mecanismo propio de aceptar/rechazar por link:
 * eso duplicaría en `appointments` el mecanismo de token que
 * `routes/public/waitlist-confirmation.ts` ya resuelve para
 * `appointment_waitlist`, y el usuario decidió no construirlo en esta
 * pasada. Si el cliente responde que no asistirá (por WhatsApp libre, o
 * verbalmente en la llamada de voz), el negocio cancela la cita desde el
 * dashboard como ya hace hoy — lo cual dispara `evaluate-waitlist-for-slot`
 * vía el enganche de la Tarea B3 (`contacts-crm.ts`).
 *
 * Por eso, fuera de la ventana de servicio de 24h de WhatsApp, esta
 * notificación NO intenta una plantilla de Meta (a diferencia de la oferta
 * de waitlist): se degrada directamente a llamada de voz en vez de exigir
 * que la organización configure otra plantilla más — mantiene el alcance
 * realmente mínimo.
 */
export async function sendBulkConfirmationRequestHandler(
    fastify: FastifyInstance,
    job: Job<SendBulkConfirmationRequestJobData>
): Promise<void> {
    const { appointmentId } = job.data;

    const { data: appt, error } = await fastify.supabaseAdmin
        .from('appointments')
        .select('id, organization_id, contact_id, customer_name, customer_phone, customer_email, start_time, status, confirmation_requested_at')
        .eq('id', appointmentId)
        .maybeSingle();

    if (error || !appt) {
        throw new Error(`No se encontró appointments.id=${appointmentId}: ${error?.message ?? 'sin datos'}`);
    }

    // Re-verificar la condición de disparo: pudo cambiar entre encolar y
    // ejecutar (la cita se canceló, o un reintento de pg-boss llega tarde).
    if (appt.confirmation_requested_at) {
        return;
    }
    if (!CONFIRMABLE_STATUSES.includes(appt.status) || !appt.customer_phone) {
        fastify.log.info(
            { appointmentId, status: appt.status, hasPhone: Boolean(appt.customer_phone) },
            'send-bulk-confirmation-request: la condición de disparo ya no aplica, se omite'
        );
        return;
    }

    const { data: org, error: orgError } = await fastify.supabaseAdmin
        .from('organizations')
        .select('name, timezone, whatsapp_phone_number_id, active_voice_provider')
        .eq('id', appt.organization_id)
        .maybeSingle();

    if (orgError || !org) {
        throw new Error(`organizations.id=${appt.organization_id} no encontrada: ${orgError?.message ?? 'sin datos'}`);
    }

    const timeZone = org.timezone || 'America/Mexico_City';
    const slotDescription = formatSlotForSpeech(appt.start_time, timeZone);

    let sentVia: 'whatsapp' | 'voice' | null = null;

    const features = await getOrganizationFeatures(appt.organization_id);
    if (features.has(FEATURE_KEYS.WHATSAPP) && org.whatsapp_phone_number_id && appt.contact_id) {
        const withinWindow = await isWithinWhatsApp24hWindow(fastify, appt.organization_id, appt.contact_id);
        if (withinWindow) {
            const sent = await sendPlainConfirmationRequestWhatsApp(fastify, {
                organizationId: appt.organization_id,
                contactId: appt.contact_id,
                phoneNumberId: org.whatsapp_phone_number_id,
                phoneE164: appt.customer_phone,
                customerName: appt.customer_name,
                businessName: org.name,
                slotDescription,
            });
            if (sent) sentVia = 'whatsapp';
        }
    }

    if (!sentVia) {
        try {
            const provider = VoiceProviderFactory.getProvider(org.active_voice_provider ?? undefined);
            await provider.triggerOutboundCall(
                {
                    organizationId: appt.organization_id,
                    customerPhone: appt.customer_phone,
                    customerName: appt.customer_name,
                    customerEmail: appt.customer_email ?? undefined,
                    companyName: org.name,
                    demoObjective: `Confirma si ${appt.customer_name} podrá asistir a su cita del ${slotDescription}. Si confirma, agradécele y despídete. Si no podrá asistir, ofrécele cancelarla con la herramienta de cancelación disponible.`,
                    customVariables: { appointment_id: appt.id },
                },
                org
            );
            sentVia = 'voice';
        } catch (err) {
            fastify.log.error(
                { appointmentId, organizationId: appt.organization_id, err: err instanceof Error ? err.message : String(err), msg: 'send-bulk-confirmation-request: falló la llamada de voz de confirmación' }
            );
        }
    }

    if (sentVia) {
        const { error: updateError } = await fastify.supabaseAdmin
            .from('appointments')
            .update({ confirmation_requested_at: new Date().toISOString() })
            .eq('id', appointmentId)
            .is('confirmation_requested_at', null);
        if (updateError) {
            fastify.log.error({ appointmentId, err: updateError.message, msg: 'send-bulk-confirmation-request: notificación enviada pero falló marcar confirmation_requested_at' });
        }
        fastify.log.info({ appointmentId, organizationId: appt.organization_id, sentVia }, 'send-bulk-confirmation-request: solicitud de confirmación entregada');
    }
}

interface SendPlainConfirmationRequestParams {
    organizationId: string;
    contactId: string;
    phoneNumberId: string;
    phoneE164: string;
    customerName: string;
    businessName: string;
    slotDescription: string;
}

async function sendPlainConfirmationRequestWhatsApp(
    fastify: FastifyInstance,
    params: SendPlainConfirmationRequestParams
): Promise<boolean> {
    const accessToken = await getSecret(params.organizationId, SECRET_KEYS.WHATSAPP_ACCESS_TOKEN);
    if (!accessToken) return false;

    const cleanPhone = params.phoneE164.replace(/[^0-9]/g, '');
    const messageBody = `Hola ${params.customerName}, te escribimos de ${params.businessName} para confirmar tu cita del ${params.slotDescription}. Si no podrás asistir, avísanos por este medio.`;

    try {
        const response = await fetch(`https://graph.facebook.com/v21.0/${params.phoneNumberId}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: cleanPhone,
                type: 'text',
                text: { body: messageBody },
            }),
        });
        const resData = (await response.json()) as any;
        if (!response.ok || resData.error) {
            fastify.log.error({ organizationId: params.organizationId, errMsg: resData.error?.message ?? response.statusText, msg: '[BulkConfirmation WhatsApp] Meta Graph API retornó error' });
            return false;
        }

        const waMessageId = resData.messages?.[0]?.id || `wa-bulk-confirm-${Date.now()}`;
        await fastify.supabaseAdmin.from('whatsapp_messages').insert({
            organization_id: params.organizationId,
            contact_id: params.contactId,
            direction: 'outbound',
            body: messageBody,
            wa_message_id: waMessageId,
            status: 'sent',
        });

        try {
            const now = new Date();
            const rate = await getRate(fastify, USAGE_EVENT_PROVIDERS.META, 'wa_service_mx', now);
            if (rate && rate.unitRateUsd > 0) {
                await fastify.supabaseAdmin.from('usage_events').insert({
                    organization_id: params.organizationId,
                    provider: USAGE_EVENT_PROVIDERS.META,
                    unit_type: 'wa_service_mx',
                    quantity: 1,
                    unit_rate_usd: rate.unitRateUsd,
                    amount_usd: rate.unitRateUsd,
                    occurred_at: now.toISOString(),
                    idempotency_key: `wa-bulk-confirm:${waMessageId}`,
                    metadata: { contact_id: params.contactId },
                });
            }
        } catch (meteringErr) {
            fastify.log.warn({ meteringErr, organizationId: params.organizationId }, '[BulkConfirmation WhatsApp] Falló el registro de consumo en usage_events');
        }

        return true;
    } catch (err) {
        fastify.log.error({ organizationId: params.organizationId, err: err instanceof Error ? err.message : String(err), msg: '[BulkConfirmation WhatsApp] Excepción al enviar mensaje' });
        return false;
    }
}

function formatSlotForSpeech(isoTime: string, timeZone: string): string {
    return new Intl.DateTimeFormat('es-MX', {
        timeZone,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    }).format(new Date(isoTime));
}

export async function registerSendBulkConfirmationRequestWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(SEND_BULK_CONFIRMATION_REQUEST_QUEUE, { retryLimit: 3, retryBackoff: true });

    await fastify.pgBoss.work<SendBulkConfirmationRequestJobData>(SEND_BULK_CONFIRMATION_REQUEST_QUEUE, async ([job]) => {
        await sendBulkConfirmationRequestHandler(fastify, job);
    });
}
