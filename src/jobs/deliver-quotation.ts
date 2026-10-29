import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { isFeatureEnabled } from '../services/entitlements.js';
import { buildQuotationEmailContent, sendQuotationEmail } from '../services/email.js';
import { dispatchOrSaveDraft } from '../services/email/email-dispatch.service.js';
import {
    downloadQuotationPdfBuffer,
    createQuotationPdfSignedUrl,
    MAX_QUOTATION_PDF_ATTACH_BYTES,
} from '../services/quotations/quotation-pdf.js';
import { sendQuotationWhatsApp } from '../services/quotations/quotation-whatsapp.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { QUOTATION_STATUSES } from '../types/quotation-status.js';
import {
    QUOTATION_DELIVERY_CHANNELS,
    QUOTATION_DELIVERY_STATUSES,
    QUOTATION_EMAIL_SENDERS,
    type QuotationEmailSender,
} from '../types/quotation-delivery.js';
import { QUOTATION_EVENT_TYPES } from '../types/quotation-event-type.js';

export const DELIVER_QUOTATION_QUEUE = 'deliver-quotation';

export interface DeliverQuotationJobData {
    organizationId: string;
    deliveryId: string;
}

export interface DeliverQuotationResult {
    status: 'enviado' | 'omitido' | 'error' | 'already_sent' | 'not_found';
    providerMessageId?: string | null;
    skipReason?: string | null;
    error?: string | null;
}

function formatTotalMoney(amount: number, currency: string): string {
    const fixed = Number(amount || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    return `$${fixed} ${currency.toUpperCase()}`;
}

export async function deliverQuotationHandler(
    fastify: FastifyInstance,
    data: DeliverQuotationJobData
): Promise<DeliverQuotationResult> {
    const { organizationId, deliveryId } = data;

    // 1. Cargar fila de entrega
    const { data: delivery, error: delError } = await fastify.supabaseAdmin
        .from('quotation_deliveries')
        .select('*')
        .eq('id', deliveryId)
        .eq('organization_id', organizationId)
        .maybeSingle();

    if (delError || !delivery) {
        fastify.log.warn(
            { tenant_id: organizationId, deliveryId, err: delError?.message },
            '[DeliverQuotation] Fila de quotation_deliveries no encontrada'
        );
        return { status: 'not_found' };
    }

    // Idempotencia: salir de inmediato si ya fue enviado
    if (delivery.status === QUOTATION_DELIVERY_STATUSES.ENVIADO) {
        return {
            status: 'already_sent',
            providerMessageId: (delivery.provider_message_id as string | null) ?? null,
        };
    }

    const quotationId = String(delivery.quotation_id);
    const attempts = Number(delivery.attempts ?? 0) + 1;

    // 2. Verificar feature `quotations` al ejecutar (§16)
    const quotationsEnabled = await isFeatureEnabled(organizationId, FEATURE_KEYS.QUOTATIONS);
    if (!quotationsEnabled) {
        await fastify.supabaseAdmin
            .from('quotation_deliveries')
            .update({
                status: QUOTATION_DELIVERY_STATUSES.OMITIDO,
                skip_reason: 'quotations_feature_deshabilitada',
                attempts,
            })
            .eq('id', deliveryId)
            .eq('organization_id', organizationId);

        return { status: 'omitido', skipReason: 'quotations_feature_deshabilitada' };
    }

    // 3. Cargar cotización, organización y configuración
    const [{ data: quotation }, { data: org }, { data: settings }] = await Promise.all([
        fastify.supabaseAdmin
            .from('quotations')
            .select('*')
            .eq('id', quotationId)
            .eq('organization_id', organizationId)
            .maybeSingle(),
        fastify.supabaseAdmin
            .from('organizations')
            .select('name')
            .eq('id', organizationId)
            .maybeSingle(),
        fastify.supabaseAdmin
            .from('quotation_settings')
            .select('email_sender, email_account_id, whatsapp_template_name')
            .eq('organization_id', organizationId)
            .maybeSingle(),
    ]);

    if (!quotation || !quotation.folio) {
        return { status: 'not_found' };
    }

    const folio = String(quotation.folio);
    const currency = String(quotation.currency ?? 'MXN');
    const totalFormatted = formatTotalMoney(Number(quotation.total ?? 0), currency);
    const businessName = (org?.name as string | null) || 'Datagol';
    const storagePath = (quotation.pdf_storage_path as string | null) ?? null;
    const conversationId = (quotation.last_conversation_id as string | null) ?? null;

    const channel = String(delivery.channel);
    const recipient = String((delivery.recipient as string | null) ?? '');

    if (!recipient) {
        await fastify.supabaseAdmin
            .from('quotation_deliveries')
            .update({
                status: QUOTATION_DELIVERY_STATUSES.OMITIDO,
                skip_reason: 'sin_destinatario',
                attempts,
            })
            .eq('id', deliveryId)
            .eq('organization_id', organizationId);
        return { status: 'omitido', skipReason: 'sin_destinatario' };
    }

    // 4. Despacho según canal
    if (channel === QUOTATION_DELIVERY_CHANNELS.EMAIL) {
        const pdfBuffer = storagePath ? await downloadQuotationPdfBuffer(fastify, storagePath) : null;
        const needsSignedUrl = !pdfBuffer || pdfBuffer.length > MAX_QUOTATION_PDF_ATTACH_BYTES;
        const pdfDownloadUrl =
            needsSignedUrl && storagePath
                ? await createQuotationPdfSignedUrl(fastify, storagePath, 3600 * 24 * 7)
                : null;

        const emailSender =
            (settings?.email_sender as QuotationEmailSender | undefined) ?? QUOTATION_EMAIL_SENDERS.AUTO;

        let useMailbox = false;
        let activeMailboxId: string | null = null;

        if (emailSender === QUOTATION_EMAIL_SENDERS.MAILBOX || emailSender === QUOTATION_EMAIL_SENDERS.AUTO) {
            const emailIntegrationEnabled = await isFeatureEnabled(organizationId, FEATURE_KEYS.EMAIL_INTEGRATION);
            if (emailIntegrationEnabled) {
                let query = fastify.supabaseAdmin
                    .from('email_accounts')
                    .select('id')
                    .eq('organization_id', organizationId)
                    .eq('status', 'active');

                if (settings?.email_account_id) {
                    query = query.eq('id', String(settings.email_account_id));
                }

                const { data: activeAccount } = await query
                    .order('created_at', { ascending: true })
                    .limit(1)
                    .maybeSingle();

                if (activeAccount?.id) {
                    useMailbox = true;
                    activeMailboxId = String(activeAccount.id);
                }
            }
        }

        if (emailSender === QUOTATION_EMAIL_SENDERS.MAILBOX && (!useMailbox || !activeMailboxId)) {
            const errMsg =
                'El remitente está configurado como buzón propio (mailbox), pero no hay buzón activo o la feature email_integration no está habilitada.';
            await markDeliveryFailed(fastify, {
                organizationId,
                quotationId,
                deliveryId,
                channel,
                recipient,
                attempts,
                errorMessage: errMsg,
                conversationId,
            });
            return { status: 'error', error: errMsg };
        }

        if (useMailbox && activeMailboxId) {
            const content = await buildQuotationEmailContent({
                organizationId,
                to: recipient,
                folio,
                businessName,
                customerName: (quotation.customer_name as string | null) ?? null,
                totalFormatted,
                validUntil: (quotation.valid_until as string | null) ?? null,
                pdfBuffer,
                pdfDownloadUrl,
            });

            const dispatchRes = await dispatchOrSaveDraft(organizationId, activeMailboxId, {
                idempotencyKey: String(delivery.idempotency_key || `quot-email:${deliveryId}`),
                toAddresses: [recipient],
                subject: content.subject,
                bodyText: content.text,
                bodyHtml: content.html,
                contactId: (quotation.contact_id as string | null) ?? null,
                isDraft: false,
                attachments: content.attachBuffer
                    ? [
                          {
                              filename: content.filename,
                              content: content.attachBuffer,
                              contentType: 'application/pdf',
                          },
                      ]
                    : undefined,
            });

            if (!dispatchRes.success) {
                await markDeliveryFailed(fastify, {
                    organizationId,
                    quotationId,
                    deliveryId,
                    channel,
                    recipient,
                    attempts,
                    errorMessage: dispatchRes.error,
                    conversationId,
                });
                return { status: 'error', error: dispatchRes.error };
            }

            await markDeliverySent(fastify, {
                organizationId,
                quotationId,
                quotationStatus: String(quotation.status),
                deliveryId,
                channel,
                recipient,
                attempts,
                providerMessageId: dispatchRes.outboxId || null,
                conversationId,
            });

            return { status: 'enviado', providerMessageId: dispatchRes.outboxId || null };
        }

        // Resend (explícito o fallback de `auto`)
        const resendRes = await sendQuotationEmail({
            organizationId,
            to: recipient,
            folio,
            businessName,
            customerName: (quotation.customer_name as string | null) ?? null,
            totalFormatted,
            validUntil: (quotation.valid_until as string | null) ?? null,
            pdfBuffer,
            pdfDownloadUrl,
        });

        if (!resendRes.sent) {
            const errMsg = resendRes.error || 'Error enviando correo con Resend';
            await markDeliveryFailed(fastify, {
                organizationId,
                quotationId,
                deliveryId,
                channel,
                recipient,
                attempts,
                errorMessage: errMsg,
                conversationId,
            });
            return { status: 'error', error: errMsg };
        }

        await markDeliverySent(fastify, {
            organizationId,
            quotationId,
            quotationStatus: String(quotation.status),
            deliveryId,
            channel,
            recipient,
            attempts,
            providerMessageId: resendRes.providerMessageId ?? null,
            conversationId,
        });

        return { status: 'enviado', providerMessageId: resendRes.providerMessageId ?? null };
    }

    if (channel === QUOTATION_DELIVERY_CHANNELS.WHATSAPP) {
        const signedPdfUrl = storagePath
            ? await createQuotationPdfSignedUrl(fastify, storagePath, 3600 * 24)
            : null;

        if (!signedPdfUrl) {
            const errMsg = 'No se pudo generar el enlace firmado del PDF para enviar por WhatsApp.';
            await markDeliveryFailed(fastify, {
                organizationId,
                quotationId,
                deliveryId,
                channel,
                recipient,
                attempts,
                errorMessage: errMsg,
                conversationId,
            });
            return { status: 'error', error: errMsg };
        }

        const waRes = await sendQuotationWhatsApp(fastify, {
            organizationId,
            quotationId,
            contactId: (quotation.contact_id as string | null) ?? null,
            phoneRaw: recipient,
            folio,
            totalFormatted,
            signedPdfUrl,
            customerName: (quotation.customer_name as string | null) ?? null,
            businessName,
            whatsappTemplateName: (settings?.whatsapp_template_name as string | null) ?? null,
        });

        if (waRes.skipReason) {
            await fastify.supabaseAdmin
                .from('quotation_deliveries')
                .update({
                    status: QUOTATION_DELIVERY_STATUSES.OMITIDO,
                    skip_reason: waRes.skipReason,
                    attempts,
                })
                .eq('id', deliveryId)
                .eq('organization_id', organizationId);

            return { status: 'omitido', skipReason: waRes.skipReason };
        }

        if (!waRes.sent) {
            const errMsg = waRes.error || 'Error enviando cotización por WhatsApp';
            await markDeliveryFailed(fastify, {
                organizationId,
                quotationId,
                deliveryId,
                channel,
                recipient,
                attempts,
                errorMessage: errMsg,
                conversationId,
            });
            return { status: 'error', error: errMsg };
        }

        await markDeliverySent(fastify, {
            organizationId,
            quotationId,
            quotationStatus: String(quotation.status),
            deliveryId,
            channel,
            recipient,
            attempts,
            providerMessageId: waRes.waMessageId ?? null,
            conversationId,
        });

        return { status: 'enviado', providerMessageId: waRes.waMessageId ?? null };
    }

    return { status: 'error', error: `Canal desconocido: ${channel}` };
}

async function markDeliverySent(
    fastify: FastifyInstance,
    params: {
        organizationId: string;
        quotationId: string;
        quotationStatus: string;
        deliveryId: string;
        channel: string;
        recipient: string;
        attempts: number;
        providerMessageId: string | null;
        conversationId: string | null;
    }
): Promise<void> {
    const nowIso = new Date().toISOString();

    await fastify.supabaseAdmin
        .from('quotation_deliveries')
        .update({
            status: QUOTATION_DELIVERY_STATUSES.ENVIADO,
            provider_message_id: params.providerMessageId,
            sent_at: nowIso,
            error: null,
            skip_reason: null,
            attempts: params.attempts,
        })
        .eq('id', params.deliveryId)
        .eq('organization_id', params.organizationId);

    await fastify.supabaseAdmin.from('quotation_events').insert({
        organization_id: params.organizationId,
        quotation_id: params.quotationId,
        event_type: QUOTATION_EVENT_TYPES.ENVIADA,
        conversation_id: params.conversationId,
        payload: {
            delivery_id: params.deliveryId,
            channel: params.channel,
            recipient: params.recipient,
            provider_message_id: params.providerMessageId,
        },
    });

    // Primer envío exitoso promueve `emitida -> enviada`
    if (params.quotationStatus === QUOTATION_STATUSES.EMITIDA) {
        await fastify.supabaseAdmin
            .from('quotations')
            .update({
                status: QUOTATION_STATUSES.ENVIADA,
            })
            .eq('id', params.quotationId)
            .eq('organization_id', params.organizationId)
            .eq('status', QUOTATION_STATUSES.EMITIDA);
    }
}

async function markDeliveryFailed(
    fastify: FastifyInstance,
    params: {
        organizationId: string;
        quotationId: string;
        deliveryId: string;
        channel: string;
        recipient: string;
        attempts: number;
        errorMessage: string;
        conversationId: string | null;
    }
): Promise<void> {
    await fastify.supabaseAdmin
        .from('quotation_deliveries')
        .update({
            status: QUOTATION_DELIVERY_STATUSES.ERROR,
            error: params.errorMessage,
            attempts: params.attempts,
        })
        .eq('id', params.deliveryId)
        .eq('organization_id', params.organizationId);

    await fastify.supabaseAdmin.from('quotation_events').insert({
        organization_id: params.organizationId,
        quotation_id: params.quotationId,
        event_type: QUOTATION_EVENT_TYPES.ENVIO_FALLIDO,
        conversation_id: params.conversationId,
        payload: {
            delivery_id: params.deliveryId,
            channel: params.channel,
            recipient: params.recipient,
            error: params.errorMessage,
            attempts: params.attempts,
        },
    });

    fastify.log.error(
        {
            tenant_id: params.organizationId,
            quotation_id: params.quotationId,
            conversation_id: params.conversationId,
            delivery_id: params.deliveryId,
            channel: params.channel,
            error: params.errorMessage,
        },
        '[DeliverQuotation] Falló la entrega de cotización'
    );
}

export async function registerDeliverQuotationWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(DELIVER_QUOTATION_QUEUE, {
        retryLimit: 3,
        retryBackoff: true,
    });

    await fastify.pgBoss.work<DeliverQuotationJobData>(
        DELIVER_QUOTATION_QUEUE,
        async ([job]: Job<DeliverQuotationJobData>[]) => {
            if (!job?.data) return;
            await deliverQuotationHandler(fastify, job.data);
        }
    );
}
