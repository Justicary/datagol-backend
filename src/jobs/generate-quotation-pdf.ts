import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { isFeatureEnabled } from '../services/entitlements.js';
import { resolveOrganizationEmailOptions } from '../services/email.js';
import {
    renderQuotationPdf,
    uploadQuotationPdf,
    type QuotationPdfItem,
    type QuotationPdfBillingBlock,
    type QuotationPdfTaxBreakdownRow,
} from '../services/quotations/quotation-pdf.js';
import { DELIVER_QUOTATION_QUEUE } from './deliver-quotation.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { QUOTATION_EVENT_TYPES } from '../types/quotation-event-type.js';
import { QUOTATION_DELIVERY_CHANNELS, QUOTATION_DELIVERY_STATUSES } from '../types/quotation-delivery.js';
import type { CatalogItemType } from '../types/catalog-item-type.js';
import type { BillingPeriod } from '../types/billing-period.js';

export const GENERATE_QUOTATION_PDF_QUEUE = 'generate-quotation-pdf';

export interface GenerateQuotationPdfJobData {
    organizationId: string;
    quotationId: string;
    deliveryChannel?: 'email' | 'whatsapp' | 'both' | 'none';
    channels?: Array<'email' | 'whatsapp'>;
    requestedChannels?: Array<'email' | 'whatsapp'>;
    idempotencyPrefix?: string;
}

export interface GenerateQuotationPdfResult {
    generated: boolean;
    alreadyExisted?: boolean;
    storagePath?: string | null;
    pdfSha256?: string | null;
    enqueuedDeliveryIds: string[];
    skipReason?: string;
}

function parseTotalsByBilling(raw: unknown): Partial<Record<BillingPeriod, QuotationPdfBillingBlock>> | undefined {
    if (!raw) return undefined;
    if (Array.isArray(raw)) {
        const result: Partial<Record<BillingPeriod, QuotationPdfBillingBlock>> = {};
        for (const item of raw) {
            if (item && typeof item === 'object') {
                const row = item as Record<string, unknown>;
                const period = (row.billingPeriod ?? row.billing_period) as BillingPeriod | undefined;
                if (period === 'unico' || period === 'mensual' || period === 'anual') {
                    result[period] = {
                        subtotal: Number(row.subtotal ?? 0),
                        discountTotal: Number(row.discount ?? row.discountTotal ?? 0),
                        taxTotal: Number(row.tax ?? row.taxTotal ?? 0),
                        total: Number(row.total ?? 0),
                    };
                }
            }
        }
        return result;
    }
    if (typeof raw === 'object') {
        return raw as Partial<Record<BillingPeriod, QuotationPdfBillingBlock>>;
    }
    return undefined;
}

function parseTaxBreakdown(raw: unknown): QuotationPdfTaxBreakdownRow[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    return raw.map((item) => {
        const row = (item ?? {}) as Record<string, unknown>;
        const rawRate = Number(row.ratePct ?? row.taxRate ?? 0.16);
        const ratePct = rawRate <= 1 ? Math.round(rawRate * 10000) / 100 : rawRate;
        return {
            ratePct,
            base: Number(row.base ?? 0),
            tax: Number(row.tax ?? 0),
        };
    });
}

export async function generateQuotationPdfHandler(
    fastify: FastifyInstance,
    data: GenerateQuotationPdfJobData
): Promise<GenerateQuotationPdfResult> {
    const { organizationId, quotationId, deliveryChannel, channels, requestedChannels, idempotencyPrefix } = data;

    // 1. Verificar feature `quotations` antes de ejecutar el efecto (§16)
    const enabled = await isFeatureEnabled(organizationId, FEATURE_KEYS.QUOTATIONS);
    if (!enabled) {
        fastify.log.warn(
            { tenant_id: organizationId, quotation_id: quotationId },
            '[GenerateQuotationPdf] Feature quotations deshabilitada al ejecutar job; se omite'
        );
        return { generated: false, enqueuedDeliveryIds: [], skipReason: 'feature_disabled' };
    }

    // 2. Cargar cotización
    const { data: quotation, error: quotError } = await fastify.supabaseAdmin
        .from('quotations')
        .select('*')
        .eq('id', quotationId)
        .eq('organization_id', organizationId)
        .maybeSingle();

    if (quotError || !quotation || !quotation.folio || !quotation.folio_year) {
        fastify.log.warn(
            { tenant_id: organizationId, quotation_id: quotationId, err: quotError?.message },
            '[GenerateQuotationPdf] Cotización no encontrada o aún no emitida'
        );
        return { generated: false, enqueuedDeliveryIds: [], skipReason: 'quotation_not_emitted' };
    }

    let storagePath = quotation.pdf_storage_path as string | null;
    let pdfSha256 = quotation.pdf_sha256 as string | null;
    let alreadyExisted = false;

    // 3. Idempotencia: no regenerar si ya tiene PDF almacenado
    if (storagePath && pdfSha256) {
        alreadyExisted = true;
    } else {
        const [{ data: org }, { data: settings }, { data: items }, emailOpts] = await Promise.all([
            fastify.supabaseAdmin
                .from('organizations')
                .select('name, timezone')
                .eq('id', organizationId)
                .maybeSingle(),
            fastify.supabaseAdmin
                .from('quotation_settings')
                .select('terms_text, notes_default')
                .eq('organization_id', organizationId)
                .maybeSingle(),
            fastify.supabaseAdmin
                .from('quotation_items')
                .select('*')
                .eq('quotation_id', quotationId)
                .eq('organization_id', organizationId)
                .order('line_number', { ascending: true }),
            resolveOrganizationEmailOptions(organizationId),
        ]);

        const pdfItems: QuotationPdfItem[] = (items ?? []).map((row, idx) => ({
            lineNumber: Number(row.line_number ?? idx + 1),
            sku: String(row.sku),
            productName: String(row.product_name),
            variantName: (row.presentation as string | null) ?? null,
            description: (row.description as string | null) ?? null,
            itemType: ((row.item_type as CatalogItemType) ?? 'producto'),
            billingPeriod: ((row.billing_period as BillingPeriod) ?? 'unico'),
            unitOfMeasure: String(row.sat_unit_key ?? 'pieza'),
            quantity: Number(row.quantity ?? 1),
            unitPrice: Number(row.unit_price ?? 0),
            discountAmount: Number(row.discount_amount ?? 0),
            lineSubtotal: Number(row.line_subtotal ?? 0),
            lineTax: Number(row.line_tax ?? 0),
            lineTotal: Number(row.line_total ?? 0),
        }));

        const taxBreakdown = parseTaxBreakdown(quotation.tax_breakdown);
        const defaultTaxPct = taxBreakdown && taxBreakdown.length > 0 ? taxBreakdown[0].ratePct : 16;

        const buffer = await renderQuotationPdf({
            organizationName: org?.name || 'Datagol',
            organizationEmail: emailOpts.replyTo ?? null,
            primaryColor: emailOpts.theme?.accent,
            folio: String(quotation.folio),
            revisionNumber: Number(quotation.revision_number ?? 0),
            emittedAt: String(quotation.issued_at || new Date().toISOString()),
            validUntil: (quotation.valid_until as string | null) ?? null,
            timezone: (org?.timezone as string | null) || 'America/Mexico_City',
            currency: String(quotation.currency ?? 'MXN'),
            taxRatePct: defaultTaxPct,
            customerName: (quotation.customer_name as string | null) ?? null,
            customerCompany: (quotation.customer_business_name as string | null) ?? null,
            customerEmail: (quotation.customer_email as string | null) ?? null,
            customerPhone: (quotation.customer_phone_e164 as string | null) ?? null,
            items: pdfItems,
            subtotal: Number(quotation.subtotal ?? 0),
            discountTotal: Number(quotation.discount_total ?? 0),
            taxTotal: Number(quotation.tax_total ?? 0),
            total: Number(quotation.total ?? 0),
            totalsByBilling: parseTotalsByBilling(quotation.totals_by_billing),
            taxBreakdown,
            notes:
                (quotation.notes as string | null) ??
                (settings?.notes_default as string | null) ??
                null,
            termsAndConditions:
                (quotation.terms_text as string | null) ??
                (settings?.terms_text as string | null) ??
                null,
        });

        const uploaded = await uploadQuotationPdf(fastify, {
            organizationId,
            folioYear: Number(quotation.folio_year),
            folio: String(quotation.folio),
            buffer,
        });

        storagePath = uploaded.storagePath;
        pdfSha256 = uploaded.pdfSha256;

        const nowIso = new Date().toISOString();
        await fastify.supabaseAdmin
            .from('quotations')
            .update({
                pdf_storage_path: storagePath,
                pdf_sha256: pdfSha256,
                pdf_generated_at: nowIso,
            })
            .eq('id', quotationId)
            .eq('organization_id', organizationId);

        await fastify.supabaseAdmin.from('quotation_events').insert({
            organization_id: organizationId,
            quotation_id: quotationId,
            event_type: QUOTATION_EVENT_TYPES.PDF_GENERADO,
            conversation_id: (quotation.last_conversation_id as string | null) ?? null,
            payload: {
                storage_path: storagePath,
                pdf_sha256: pdfSha256,
                size_bytes: uploaded.sizeBytes,
            },
        });
    }

    // 4. Crear filas en quotation_deliveries con ON CONFLICT DO NOTHING y encolar deliver-quotation
    const targetChannels: Array<'email' | 'whatsapp'> =
        requestedChannels ??
        channels ??
        (deliveryChannel === 'both'
            ? [QUOTATION_DELIVERY_CHANNELS.EMAIL, QUOTATION_DELIVERY_CHANNELS.WHATSAPP]
            : deliveryChannel === 'email'
              ? [QUOTATION_DELIVERY_CHANNELS.EMAIL]
              : deliveryChannel === 'whatsapp'
                ? [QUOTATION_DELIVERY_CHANNELS.WHATSAPP]
                : []);

    const prefix = idempotencyPrefix || `quotation-delivery:${quotationId}`;
    for (const channel of targetChannels) {
        const recipient =
            channel === QUOTATION_DELIVERY_CHANNELS.EMAIL
                ? (quotation.customer_email as string | null)
                : (quotation.customer_phone_e164 as string | null);

        if (!recipient || !recipient.trim()) {
            continue;
        }

        const idempotencyKey = `${prefix}:${channel}:initial`;
        await fastify.supabaseAdmin
            .from('quotation_deliveries')
            .upsert(
                {
                    organization_id: organizationId,
                    quotation_id: quotationId,
                    channel,
                    recipient: recipient.trim(),
                    status: QUOTATION_DELIVERY_STATUSES.PENDIENTE,
                    idempotency_key: idempotencyKey,
                },
                { onConflict: 'organization_id,idempotency_key', ignoreDuplicates: true }
            );
    }

    const { data: pendingDeliveries } = await fastify.supabaseAdmin
        .from('quotation_deliveries')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('quotation_id', quotationId)
        .eq('status', QUOTATION_DELIVERY_STATUSES.PENDIENTE);

    const enqueuedDeliveryIds: string[] = [];
    for (const row of pendingDeliveries ?? []) {
        const deliveryId = String(row.id);
        enqueuedDeliveryIds.push(deliveryId);
        if (fastify.pgBoss) {
            try {
                await fastify.pgBoss.send(
                    DELIVER_QUOTATION_QUEUE,
                    { organizationId, deliveryId },
                    { singletonKey: `deliver-quotation:${deliveryId}` }
                );
            } catch (bossErr) {
                fastify.log.warn(
                    { err: bossErr, tenant_id: organizationId, quotation_id: quotationId, deliveryId },
                    '[GenerateQuotationPdf] Error encolando deliver-quotation en pg-boss'
                );
            }
        }
    }

    return {
        generated: !alreadyExisted,
        alreadyExisted,
        storagePath,
        pdfSha256,
        enqueuedDeliveryIds,
    };
}

export async function registerGenerateQuotationPdfWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(GENERATE_QUOTATION_PDF_QUEUE, {
        retryLimit: 3,
        retryBackoff: true,
    });

    await fastify.pgBoss.work<GenerateQuotationPdfJobData>(
        GENERATE_QUOTATION_PDF_QUEUE,
        async ([job]: Job<GenerateQuotationPdfJobData>[]) => {
            if (!job?.data) return;
            await generateQuotationPdfHandler(fastify, job.data);
        }
    );
}
