import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveToolOrganization } from '../../lib/tool-auth.js';
import { withToolTimeout } from '../../lib/tool-timeout.js';
import { isFeatureEnabled } from '../../services/entitlements.js';
import { FEATURE_KEYS } from '../../types/feature-taxonomy.js';
import { stockStatusToSpeech } from '../../types/stock-status.js';
import { toolParamsSchema } from '../../schemas/tool-routes.js';
import { normalizePhoneE164 } from '../../services/phone-normalization.js';
import { resolveContactBestEffort } from './booking.js';
import { amountToSpokenSpanish } from '../../lib/number-to-spanish-words.js';
import {
    calculateQuotationTotals,
    halfUpRoundCents,
    type QuotationLineInput,
} from '../../services/quotations/quotation-math.js';
import { buildCartSpokenSummary } from '../../services/quotations/quotation-cart-summary.js';
import { computeValidUntilDate } from '../../services/quotations/quotation-validity.js';
import {
    MAX_QUOTATION_SEARCH_RESULTS,
    quotationSearchBodySchema,
    quotationSearchResponseSchema,
    quotationCartSetItemBodySchema,
    quotationCartRemoveItemBodySchema,
    quotationCartViewBodySchema,
    quotationFinalizeBodySchema,
    quotationCartResponseSchema,
    quotationFinalizeResponseSchema,
} from '../../schemas/quotation-tool.js';
import type { CatalogItemType } from '../../types/catalog-item-type.js';
import type { BillingPeriod } from '../../types/billing-period.js';

export const GENERATE_QUOTATION_PDF_QUEUE = 'generate-quotation-pdf';

const FEATURE_DISABLED_MESSAGE =
    'No puedo armar cotizaciones en este momento; ¿le tomo sus datos y le enviamos la información?';
const DEGRADED_SEARCH_MESSAGE =
    'No puedo consultar el catálogo en este momento; ¿le tomo sus datos para enviarle la cotización en breve?';
const DEGRADED_CART_MESSAGE =
    'Tuve un inconveniente temporal al guardar su cotización; ¿me permite confirmar sus datos para enviársela en unos minutos?';
const MISSING_CONTACT_MESSAGE =
    'Para poder guardarle su cotización, ¿me proporciona su número de teléfono o su correo electrónico?';

interface SearchProductRow {
    sku: string;
    product_name: string;
    presentation: string | null;
    description: string | null;
    item_type: CatalogItemType;
    is_inventoriable: boolean;
    billing_period: BillingPeriod;
    price: number | string | null;
    currency: string;
    price_includes_tax: boolean;
    tax_rate: number | string;
    stock_status: string;
    maintenance_sku: string | null;
}

interface CartRpcItemRow {
    sku: string;
    productName: string;
    presentation: string | null;
    itemType: CatalogItemType;
    billingPeriod: BillingPeriod;
    quantity: number;
    unitPrice: number;
    priceIncludesTax: boolean;
    taxRate: number;
    discountAmount: number;
    lineSubtotal: number;
    lineTax: number;
    lineTotal: number;
}

interface CartRpcResult {
    ok: boolean;
    errorCode?: string;
    message?: string;
    hasCart?: boolean;
    quotationId?: string | null;
    currency?: string;
    resumed?: boolean;
    items?: CartRpcItemRow[];
    suggestedComplement?: {
        sku: string;
        productName: string;
        presentation?: string | null;
        price: number;
        currency: string;
        billingPeriod: string;
    } | null;
}

function formatSpokenVariantPrice(
    price: number | null,
    currency: string,
    billingPeriod: BillingPeriod,
    priceIncludesTax: boolean
): string {
    if (price === null) {
        return 'se cotiza a medida con un asesor';
    }
    const cents = halfUpRoundCents(price * 100);
    const words = amountToSpokenSpanish(cents, currency);
    const periodSuffix =
        billingPeriod === 'mensual' ? ' mensuales' : billingPeriod === 'anual' ? ' anuales' : ' de pago único';
    const taxSuffix = priceIncludesTax ? ', IVA incluido' : ', más IVA';
    return `${words}${periodSuffix}${taxSuffix}`;
}

async function authenticateQuotationTool(
    fastify: FastifyInstance,
    request: FastifyRequest,
    reply: FastifyReply
): Promise<{ organizationId: string } | null> {
    const paramsResult = toolParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
        reply.status(400).send({ error: 'BadRequest', message: 'webhookToken inválido en la ruta' });
        return null;
    }

    const secretHeader = request.headers['x-tool-secret'] as string | undefined;
    const auth = await resolveToolOrganization(fastify, paramsResult.data.webhookToken, secretHeader);
    if (!auth.ok) {
        const statusCode = auth.reason === 'suspended' ? 403 : 401;
        request.log.warn({ reason: auth.reason, route: request.url, msg: 'Tool call de cotización rechazado' });
        reply.status(statusCode).send({
            error: statusCode === 403 ? 'Forbidden' : 'Unauthorized',
            message: auth.message,
        });
        return null;
    }

    return { organizationId: auth.organizationId };
}

function formatCartRpcResponse(rpcData: CartRpcResult) {
    if (!rpcData.ok) {
        return quotationCartResponseSchema.parse({
            ok: false,
            errorCode: rpcData.errorCode,
            items: [],
            totalsByBilling: [],
            message: rpcData.message ?? DEGRADED_CART_MESSAGE,
        });
    }

    const rawItems = rpcData.items ?? [];
    const currency = (rpcData.currency ?? 'MXN').toUpperCase();

    if (rawItems.length === 0) {
        return quotationCartResponseSchema.parse({
            ok: true,
            quotationId: rpcData.quotationId ?? null,
            hasCart: false,
            resumed: Boolean(rpcData.resumed),
            currency,
            items: [],
            totalsByBilling: [],
            subtotal: 0,
            taxTotal: 0,
            total: 0,
            spokenItems: 'El carrito está vacío',
            spokenTotal: amountToSpokenSpanish(0, currency),
            spokenSummary: 'Su cotización aún no tiene partidas.',
            message: 'Su cotización aún no tiene partidas.',
        });
    }

    const mathInputs: QuotationLineInput[] = rawItems.map((it) => ({
        sku: it.sku,
        productName: it.productName,
        presentation: it.presentation ?? null,
        itemType: it.itemType,
        billingPeriod: it.billingPeriod,
        quantity: Number(it.quantity),
        unitPrice: Number(it.unitPrice),
        currency,
        priceIncludesTax: Boolean(it.priceIncludesTax),
        taxRate: Number(it.taxRate),
        discountAmount: Number(it.discountAmount ?? 0),
    }));

    const totals = calculateQuotationTotals(mathInputs);
    const spoken = buildCartSpokenSummary({
        lines: totals.lines,
        totals,
        resumed: Boolean(rpcData.resumed),
    });

    const complement = rpcData.suggestedComplement
        ? {
              sku: rpcData.suggestedComplement.sku,
              productName: rpcData.suggestedComplement.productName,
              presentation: rpcData.suggestedComplement.presentation ?? null,
              price: Number(rpcData.suggestedComplement.price),
              currency: rpcData.suggestedComplement.currency,
              billingPeriod: rpcData.suggestedComplement.billingPeriod,
          }
        : null;

    return quotationCartResponseSchema.parse({
        ok: true,
        quotationId: rpcData.quotationId ?? null,
        hasCart: true,
        resumed: Boolean(rpcData.resumed),
        currency: totals.currency,
        items: totals.lines.map((l) => ({
            sku: l.sku,
            productName: l.productName,
            presentation: l.presentation ?? null,
            itemType: l.itemType,
            billingPeriod: l.billingPeriod,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            currency: l.currency,
            priceIncludesTax: l.priceIncludesTax,
            taxRate: l.taxRate,
            discountAmount: l.discountAmount,
            lineSubtotal: l.lineSubtotal,
            lineTax: l.lineTax,
            lineTotal: l.lineTotal,
        })),
        totalsByBilling: totals.totalsByBilling.map((b) => ({
            billingPeriod: b.billingPeriod,
            subtotal: b.subtotal,
            tax: b.tax,
            discount: b.discount,
            total: b.total,
        })),
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        spokenItems: spoken.spokenItems,
        spokenTotal: spoken.spokenTotal,
        spokenSummary: spoken.spokenSummary,
        suggestedComplement: complement,
        message: spoken.spokenSummary,
    });
}

export async function quotationToolRoutes(fastify: FastifyInstance) {
    /**
     * POST /tools/:webhookToken/quotation/search
     */
    fastify.post('/tools/:webhookToken/quotation/search', async (request, reply) => {
        const auth = await authenticateQuotationTool(fastify, request, reply);
        if (!auth) return;

        const bodyResult = quotationSearchBodySchema.safeParse(request.body ?? {});
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Parámetros de búsqueda inválidos.' });
        }

        const enabled = await isFeatureEnabled(auth.organizationId, FEATURE_KEYS.QUOTATIONS);
        if (!enabled) {
            return reply
                .status(200)
                .send(quotationSearchResponseSchema.parse({ results: [], message: FEATURE_DISABLED_MESSAGE }));
        }

        const limit = Math.min(bodyResult.data.limit, MAX_QUOTATION_SEARCH_RESULTS);

        try {
            const rows = await withToolTimeout(async (signal) => {
                const { data, error } = await fastify.supabaseAdmin
                    .rpc('quotation_search_products', {
                        p_org_id: auth.organizationId,
                        p_query: bodyResult.data.query,
                        p_limit: limit,
                    })
                    .abortSignal(signal);
                if (error) throw new Error(error.message);
                return (data as SearchProductRow[] | null) ?? [];
            });

            const results = rows.slice(0, MAX_QUOTATION_SEARCH_RESULTS).map((r) => {
                const price = r.price === null ? null : Number(r.price);
                const isInventoriable = Boolean(r.is_inventoriable) && r.stock_status !== 'no_aplica';
                const availabilitySpeech = isInventoriable ? stockStatusToSpeech(r.stock_status) : '';

                return {
                    sku: r.sku,
                    productName: r.product_name,
                    presentation: r.presentation,
                    description: r.description,
                    itemType: r.item_type,
                    billingPeriod: r.billing_period,
                    price,
                    currency: r.currency,
                    priceIncludesTax: Boolean(r.price_includes_tax),
                    ...(availabilitySpeech ? { availabilityText: availabilitySpeech } : {}),
                    maintenanceSku: r.maintenance_sku ?? null,
                    spokenPrice: formatSpokenVariantPrice(price, r.currency, r.billing_period, Boolean(r.price_includes_tax)),
                };
            });

            return reply.status(200).send(quotationSearchResponseSchema.parse({ results }));
        } catch (err) {
            request.log.error({
                tenant_id: auth.organizationId,
                err: err instanceof Error ? err.message : String(err),
                msg: 'Tool quotation/search degradado',
            });
            return reply
                .status(200)
                .send(quotationSearchResponseSchema.parse({ results: [], message: DEGRADED_SEARCH_MESSAGE }));
        }
    });

    /**
     * POST /tools/:webhookToken/quotation/cart/set-item
     */
    fastify.post('/tools/:webhookToken/quotation/cart/set-item', async (request, reply) => {
        const auth = await authenticateQuotationTool(fastify, request, reply);
        if (!auth) return;

        const bodyResult = quotationCartSetItemBodySchema.safeParse(request.body ?? {});
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Parámetros de carrito inválidos.' });
        }

        const enabled = await isFeatureEnabled(auth.organizationId, FEATURE_KEYS.QUOTATIONS);
        if (!enabled) {
            return reply.status(200).send(
                quotationCartResponseSchema.parse({
                    ok: false,
                    errorCode: 'FEATURE_DISABLED',
                    items: [],
                    totalsByBilling: [],
                    message: FEATURE_DISABLED_MESSAGE,
                })
            );
        }

        const { conversationId, customerPhone, customerEmail, customerName, channel, sku, quantity } = bodyResult.data;

        try {
            const contactId = await withToolTimeout(async () =>
                resolveContactBestEffort(
                    fastify,
                    auth.organizationId,
                    customerName?.trim() || 'Prospecto',
                    customerPhone?.trim() || null,
                    customerEmail?.trim() || null
                )
            );

            if (!contactId) {
                return reply.status(200).send(
                    quotationCartResponseSchema.parse({
                        ok: false,
                        errorCode: 'MISSING_CONTACT',
                        items: [],
                        totalsByBilling: [],
                        message: MISSING_CONTACT_MESSAGE,
                    })
                );
            }

            const rpcData = await withToolTimeout(async (signal) => {
                const { data, error } = await fastify.supabaseAdmin
                    .rpc('quotation_cart_apply', {
                        p_org_id: auth.organizationId,
                        p_contact_id: contactId,
                        p_conversation_id: conversationId,
                        p_channel: channel,
                        p_op: 'set',
                        p_sku: sku,
                        p_quantity: quantity,
                    })
                    .abortSignal(signal);
                if (error) throw new Error(error.message);
                return data as CartRpcResult;
            });

            return reply.status(200).send(formatCartRpcResponse(rpcData));
        } catch (err) {
            request.log.error({
                tenant_id: auth.organizationId,
                conversation_id: conversationId,
                err: err instanceof Error ? err.message : String(err),
                msg: 'Tool quotation/cart/set-item degradado',
            });
            return reply.status(200).send(
                quotationCartResponseSchema.parse({
                    ok: false,
                    errorCode: 'DEGRADED',
                    items: [],
                    totalsByBilling: [],
                    message: DEGRADED_CART_MESSAGE,
                })
            );
        }
    });

    /**
     * POST /tools/:webhookToken/quotation/cart/remove-item
     */
    fastify.post('/tools/:webhookToken/quotation/cart/remove-item', async (request, reply) => {
        const auth = await authenticateQuotationTool(fastify, request, reply);
        if (!auth) return;

        const bodyResult = quotationCartRemoveItemBodySchema.safeParse(request.body ?? {});
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Parámetros de remove-item inválidos.' });
        }

        const enabled = await isFeatureEnabled(auth.organizationId, FEATURE_KEYS.QUOTATIONS);
        if (!enabled) {
            return reply.status(200).send(
                quotationCartResponseSchema.parse({
                    ok: false,
                    errorCode: 'FEATURE_DISABLED',
                    items: [],
                    totalsByBilling: [],
                    message: FEATURE_DISABLED_MESSAGE,
                })
            );
        }

        const { conversationId, customerPhone, customerEmail, channel, sku } = bodyResult.data;

        try {
            const contactId = await withToolTimeout(async () =>
                resolveContactBestEffort(
                    fastify,
                    auth.organizationId,
                    'Prospecto',
                    customerPhone?.trim() || null,
                    customerEmail?.trim() || null
                )
            );

            if (!contactId) {
                return reply.status(200).send(
                    quotationCartResponseSchema.parse({
                        ok: false,
                        errorCode: 'MISSING_CONTACT',
                        items: [],
                        totalsByBilling: [],
                        message: MISSING_CONTACT_MESSAGE,
                    })
                );
            }

            const rpcData = await withToolTimeout(async (signal) => {
                const { data, error } = await fastify.supabaseAdmin
                    .rpc('quotation_cart_apply', {
                        p_org_id: auth.organizationId,
                        p_contact_id: contactId,
                        p_conversation_id: conversationId,
                        p_channel: channel,
                        p_op: 'remove',
                        p_sku: sku,
                        p_quantity: 0,
                    })
                    .abortSignal(signal);
                if (error) throw new Error(error.message);
                return data as CartRpcResult;
            });

            return reply.status(200).send(formatCartRpcResponse(rpcData));
        } catch (err) {
            request.log.error({
                tenant_id: auth.organizationId,
                conversation_id: conversationId,
                err: err instanceof Error ? err.message : String(err),
                msg: 'Tool quotation/cart/remove-item degradado',
            });
            return reply.status(200).send(
                quotationCartResponseSchema.parse({
                    ok: false,
                    errorCode: 'DEGRADED',
                    items: [],
                    totalsByBilling: [],
                    message: DEGRADED_CART_MESSAGE,
                })
            );
        }
    });

    /**
     * POST /tools/:webhookToken/quotation/cart/view
     */
    fastify.post('/tools/:webhookToken/quotation/cart/view', async (request, reply) => {
        const auth = await authenticateQuotationTool(fastify, request, reply);
        if (!auth) return;

        const bodyResult = quotationCartViewBodySchema.safeParse(request.body ?? {});
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Parámetros de view inválidos.' });
        }

        const enabled = await isFeatureEnabled(auth.organizationId, FEATURE_KEYS.QUOTATIONS);
        if (!enabled) {
            return reply.status(200).send(
                quotationCartResponseSchema.parse({
                    ok: false,
                    errorCode: 'FEATURE_DISABLED',
                    items: [],
                    totalsByBilling: [],
                    message: FEATURE_DISABLED_MESSAGE,
                })
            );
        }

        const { conversationId, customerPhone, customerEmail, channel } = bodyResult.data;
        const effectiveChannel = !customerPhone?.trim() && customerEmail?.trim() ? 'web' : channel;

        try {
            const contactId = await withToolTimeout(async () =>
                resolveContactBestEffort(
                    fastify,
                    auth.organizationId,
                    'Prospecto',
                    customerPhone?.trim() || null,
                    customerEmail?.trim() || null
                )
            );

            if (!contactId) {
                return reply.status(200).send(
                    quotationCartResponseSchema.parse({
                        ok: false,
                        errorCode: 'MISSING_CONTACT',
                        items: [],
                        totalsByBilling: [],
                        message: MISSING_CONTACT_MESSAGE,
                    })
                );
            }

            const rpcData = await withToolTimeout(async (signal) => {
                const { data, error } = await fastify.supabaseAdmin
                    .rpc('quotation_cart_apply', {
                        p_org_id: auth.organizationId,
                        p_contact_id: contactId,
                        p_conversation_id: conversationId,
                        p_channel: effectiveChannel,
                        p_op: 'view',
                        p_sku: null,
                        p_quantity: null,
                    })
                    .abortSignal(signal);
                if (error) throw new Error(error.message);
                return data as CartRpcResult;
            });

            return reply.status(200).send(formatCartRpcResponse(rpcData));
        } catch (err) {
            request.log.error({
                tenant_id: auth.organizationId,
                conversation_id: conversationId,
                err: err instanceof Error ? err.message : String(err),
                msg: 'Tool quotation/cart/view degradado',
            });
            return reply.status(200).send(
                quotationCartResponseSchema.parse({
                    ok: false,
                    errorCode: 'DEGRADED',
                    items: [],
                    totalsByBilling: [],
                    message: DEGRADED_CART_MESSAGE,
                })
            );
        }
    });

    /**
     * POST /tools/:webhookToken/quotation/finalize
     */
    fastify.post('/tools/:webhookToken/quotation/finalize', async (request, reply) => {
        const auth = await authenticateQuotationTool(fastify, request, reply);
        if (!auth) return;

        const bodyResult = quotationFinalizeBodySchema.safeParse(request.body ?? {});
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Parámetros de finalize inválidos.' });
        }

        const enabled = await isFeatureEnabled(auth.organizationId, FEATURE_KEYS.QUOTATIONS);
        if (!enabled) {
            return reply.status(200).send(
                quotationFinalizeResponseSchema.parse({
                    ok: false,
                    errorCode: 'FEATURE_DISABLED',
                    priceChanges: [],
                    message: FEATURE_DISABLED_MESSAGE,
                })
            );
        }

        const { conversationId, customerPhone, customerEmail, customerName, customerBusinessName, channels, notes } =
            bodyResult.data;

        try {
            const contactId = await withToolTimeout(async () =>
                resolveContactBestEffort(
                    fastify,
                    auth.organizationId,
                    customerName.trim(),
                    customerPhone?.trim() || null,
                    customerEmail?.trim() || null
                )
            );

            if (!contactId) {
                return reply.status(200).send(
                    quotationFinalizeResponseSchema.parse({
                        ok: false,
                        errorCode: 'MISSING_CONTACT',
                        priceChanges: [],
                        message: MISSING_CONTACT_MESSAGE,
                    })
                );
            }

            // Resolver datos actuales del contacto para validar canales solicitados
            const { data: contactRow } = await fastify.supabaseAdmin
                .from('contacts')
                .select('phone_e164, email, full_name, business_name')
                .eq('id', contactId)
                .maybeSingle();

            const normalizedInputPhone = customerPhone?.trim()
                ? normalizePhoneE164(customerPhone.trim())
                : null;
            const effectivePhoneE164 =
                (normalizedInputPhone?.success ? normalizedInputPhone.phoneE164 : null) ??
                (contactRow?.phone_e164 as string | null) ??
                null;
            const effectiveEmail =
                customerEmail?.trim().toLowerCase() || (contactRow?.email as string | null) || null;

            if (channels.includes('whatsapp') && !effectivePhoneE164) {
                return reply.status(200).send(
                    quotationFinalizeResponseSchema.parse({
                        ok: false,
                        errorCode: 'MISSING_PHONE',
                        priceChanges: [],
                        message:
                            'Para enviarle la cotización por WhatsApp necesito su número de teléfono a diez dígitos, ¿me lo proporciona?',
                    })
                );
            }

            if (channels.includes('email') && (!effectiveEmail || !effectiveEmail.includes('@'))) {
                return reply.status(200).send(
                    quotationFinalizeResponseSchema.parse({
                        ok: false,
                        errorCode: 'MISSING_EMAIL',
                        priceChanges: [],
                        message:
                            'Para enviarle la cotización por correo electrónico, ¿me indica su dirección de correo?',
                    })
                );
            }

            // Actualizar datos del contacto si aportó correo/teléfono/nombre nuevos
            const contactUpdates: Record<string, unknown> = { full_name: customerName.trim() };
            if (effectiveEmail && !contactRow?.email) contactUpdates.email = effectiveEmail;
            if (effectivePhoneE164 && !contactRow?.phone_e164) contactUpdates.phone_e164 = effectivePhoneE164;
            if (customerBusinessName?.trim()) contactUpdates.business_name = customerBusinessName.trim();
            await fastify.supabaseAdmin.from('contacts').update(contactUpdates).eq('id', contactId);

            // Buscar borrador abierto del contacto
            const { data: draft } = await fastify.supabaseAdmin
                .from('quotations')
                .select('id, currency')
                .eq('organization_id', auth.organizationId)
                .eq('contact_id', contactId)
                .eq('status', 'borrador')
                .maybeSingle();

            if (!draft) {
                // Idempotencia de finalize (D2): si ya se emitió una cotización en esta conversación en los últimos 30 min, devolverla
                const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
                const { data: recentEmitted } = await fastify.supabaseAdmin
                    .from('quotations')
                    .select('id, folio, valid_until, currency, subtotal, tax_total, total')
                    .eq('organization_id', auth.organizationId)
                    .eq('contact_id', contactId)
                    .eq('last_conversation_id', conversationId)
                    .in('status', ['emitida', 'enviada', 'aceptada'])
                    .gte('issued_at', thirtyMinAgo)
                    .order('issued_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (recentEmitted && recentEmitted.folio) {
                    const totalCents = halfUpRoundCents(Number(recentEmitted.total) * 100);
                    const spokenTotal = `${amountToSpokenSpanish(totalCents, recentEmitted.currency as string)}, IVA incluido`;
                    return reply.status(200).send(
                        quotationFinalizeResponseSchema.parse({
                            ok: true,
                            alreadyEmitted: true,
                            quotationId: recentEmitted.id as string,
                            folio: recentEmitted.folio as string,
                            validUntil: (recentEmitted.valid_until as string | null) ?? null,
                            currency: recentEmitted.currency as string,
                            subtotal: Number(recentEmitted.subtotal),
                            taxTotal: Number(recentEmitted.tax_total),
                            total: Number(recentEmitted.total),
                            spokenTotal,
                            priceChanges: [],
                            message: `Su cotización con folio ${recentEmitted.folio} ya quedó emitida por un total de ${spokenTotal}.`,
                        })
                    );
                }

                return reply.status(200).send(
                    quotationFinalizeResponseSchema.parse({
                        ok: false,
                        errorCode: 'EMPTY_CART',
                        priceChanges: [],
                        message: 'Su cotización aún no tiene partidas agregadas.',
                    })
                );
            }

            const emitResponse = await emitDraftQuotation(fastify, {
                organizationId: auth.organizationId,
                quotationId: draft.id as string,
                conversationId,
                customer: {
                    name: customerName.trim(),
                    email: effectiveEmail,
                    phoneE164: effectivePhoneE164,
                    businessName: customerBusinessName?.trim() || (contactRow?.business_name as string | null) || null,
                },
                channels,
                notes: notes?.trim() || null,
            });

            return reply.status(200).send(quotationFinalizeResponseSchema.parse(emitResponse));
        } catch (err) {
            request.log.error({
                tenant_id: auth.organizationId,
                conversation_id: conversationId,
                err: err instanceof Error ? err.message : String(err),
                msg: 'Tool quotation/finalize degradado',
            });
            return reply.status(200).send(
                quotationFinalizeResponseSchema.parse({
                    ok: false,
                    errorCode: 'DEGRADED',
                    priceChanges: [],
                    message: DEGRADED_CART_MESSAGE,
                })
            );
        }
    });
}

export async function emitDraftQuotation(
    fastify: FastifyInstance,
    params: {
        organizationId: string;
        quotationId: string;
        conversationId?: string | null;
        actorUserId?: string | null;
        customer: {
            name: string | null;
            email: string | null;
            phoneE164: string | null;
            businessName?: string | null;
        };
        channels?: readonly ('email' | 'whatsapp')[];
        notes?: string | null;
    }
): Promise<{
    ok: boolean;
    errorCode?: string;
    alreadyEmitted?: boolean;
    quotationId?: string;
    folio?: string;
    validUntil?: string | null;
    currency?: string;
    subtotal?: number;
    taxTotal?: number;
    total?: number;
    spokenTotal?: string;
    priceChanges: Array<{ sku: string; productName: string; oldPrice: number; newPrice: number }>;
    message: string;
}> {
    const { organizationId, quotationId, conversationId, actorUserId, customer, channels = [], notes } = params;

    if (notes) {
        await fastify.supabaseAdmin
            .from('quotations')
            .update({ notes })
            .eq('id', quotationId)
            .eq('organization_id', organizationId)
            .eq('status', 'borrador');
    }

    const { data: items, error: itemsErr } = await fastify.supabaseAdmin
        .from('quotation_items')
        .select('*')
        .eq('quotation_id', quotationId)
        .eq('organization_id', organizationId)
        .order('line_number', { ascending: true });

    if (itemsErr || !items || items.length === 0) {
        return {
            ok: false,
            errorCode: 'EMPTY_CART',
            priceChanges: [],
            message: 'Su cotización aún no tiene partidas agregadas.',
        };
    }

    const priceChanges: Array<{ sku: string; productName: string; oldPrice: number; newPrice: number }> = [];
    const mathInputs: QuotationLineInput[] = [];

    for (const item of items) {
        const { data: resolved } = await fastify.supabaseAdmin
            .rpc('resolve_variant_for_org', {
                p_org_id: organizationId,
                p_sku: item.sku as string,
            })
            .maybeSingle();

        const resRow = resolved as {
            variant_id?: string;
            product_name?: string;
            presentation?: string | null;
            price?: number | string | null;
            currency?: string;
            price_includes_tax?: boolean;
            tax_rate?: number | string;
            stock_status?: string;
            is_available?: boolean;
            item_type?: CatalogItemType;
            is_inventoriable?: boolean;
            billing_period?: BillingPeriod;
        } | null;

        if (!resRow || !resRow.variant_id || !resRow.is_available) {
            return {
                ok: false,
                errorCode: 'ITEM_UNAVAILABLE',
                priceChanges: [],
                message: `La partida "${item.product_name}" (${item.sku}) ya no está disponible en el catálogo.`,
            };
        }

        if (resRow.is_inventoriable && resRow.stock_status === 'agotado') {
            return {
                ok: false,
                errorCode: 'ITEM_OUT_OF_STOCK',
                priceChanges: [],
                message: `El producto "${item.product_name}" (${item.sku}) se agotó antes de emitir la cotización.`,
            };
        }

        if (resRow.price === null || resRow.price === undefined) {
            return {
                ok: false,
                errorCode: 'ITEM_CUSTOM_PRICE',
                priceChanges: [],
                message: `La partida "${item.product_name}" pasó a cotización a medida.`,
            };
        }

        const newPrice = Number(resRow.price);
        const oldPrice = Number(item.unit_price);
        if (newPrice !== oldPrice) {
            priceChanges.push({
                sku: item.sku as string,
                productName: resRow.product_name ?? (item.product_name as string),
                oldPrice,
                newPrice,
            });
        }

        mathInputs.push({
            sku: item.sku as string,
            productName: resRow.product_name ?? (item.product_name as string),
            presentation: resRow.presentation ?? (item.presentation as string | null) ?? null,
            itemType: (resRow.item_type ?? item.item_type) as CatalogItemType,
            billingPeriod: (resRow.billing_period ?? item.billing_period) as BillingPeriod,
            quantity: Number(item.quantity),
            unitPrice: newPrice,
            currency: (resRow.currency ?? 'MXN') as string,
            priceIncludesTax: Boolean(resRow.price_includes_tax),
            taxRate: Number(resRow.tax_rate ?? item.tax_rate ?? 0.16),
            discountAmount: Number(item.discount_amount ?? 0),
        });
    }

    const totals = calculateQuotationTotals(mathInputs);
    const spoken = buildCartSpokenSummary({
        lines: totals.lines,
        totals,
        resumed: false,
    });

    const [{ data: orgRow }, { data: settingsRow }] = await Promise.all([
        fastify.supabaseAdmin.from('organizations').select('timezone').eq('id', organizationId).maybeSingle(),
        fastify.supabaseAdmin
            .from('quotation_settings')
            .select('validity_days')
            .eq('organization_id', organizationId)
            .maybeSingle(),
    ]);

    const timezone = (orgRow?.timezone as string | null) || 'America/Mexico_City';
    const validityDays = Number(settingsRow?.validity_days ?? 15);
    const validUntil = computeValidUntilDate(new Date(), validityDays, timezone);

    const { data: emitData, error: emitErr } = await fastify.supabaseAdmin.rpc('quotation_emit', {
        p_org_id: organizationId,
        p_quotation_id: quotationId,
        p_customer: {
            name: customer.name,
            email: customer.email,
            phoneE164: customer.phoneE164,
            businessName: customer.businessName ?? null,
            conversationId: conversationId ?? null,
            actorUserId: actorUserId ?? null,
        },
        p_totals: {
            subtotal: totals.subtotal,
            taxTotal: totals.taxTotal,
            discountTotal: totals.discountTotal,
            total: totals.total,
            validUntil,
            totalsByBilling: totals.totalsByBilling.map((b) => ({
                billingPeriod: b.billingPeriod,
                subtotal: b.subtotal,
                tax: b.tax,
                discount: b.discount,
                total: b.total,
            })),
            taxBreakdown: totals.taxBreakdown.map((t) => ({
                taxRate: t.taxRate,
                base: t.base,
                tax: t.tax,
            })),
            lines: totals.lines.map((l) => ({
                sku: l.sku,
                discountAmount: l.discountAmount,
                lineSubtotal: l.lineSubtotal,
                lineTax: l.lineTax,
                lineTotal: l.lineTotal,
            })),
            priceChanges,
        },
    });

    if (emitErr) {
        throw new Error(emitErr.message);
    }

    const emitResult = emitData as {
        ok: boolean;
        errorCode?: string;
        message?: string;
        alreadyEmitted?: boolean;
        quotationId?: string;
        folio?: string;
        validUntil?: string | null;
        priceChanges?: Array<{ sku: string; productName: string; oldPrice: number; newPrice: number }>;
    };

    if (!emitResult.ok) {
        return {
            ok: false,
            errorCode: emitResult.errorCode,
            priceChanges: [],
            message: emitResult.message ?? DEGRADED_CART_MESSAGE,
        };
    }

    const finalPriceChanges = emitResult.priceChanges ?? priceChanges;

    if (!emitResult.alreadyEmitted) {
        // Registrar entregas solicitadas (idempotente) y encolar generación de PDF
        for (const ch of channels) {
            const recipient = ch === 'email' ? customer.email : customer.phoneE164;
            if (!recipient) continue;
            await fastify.supabaseAdmin.from('quotation_deliveries').upsert(
                {
                    organization_id: organizationId,
                    quotation_id: quotationId,
                    channel: ch,
                    recipient,
                    status: 'pendiente',
                    idempotency_key: `quotation-delivery:${quotationId}:${ch}:initial`,
                },
                { onConflict: 'organization_id,idempotency_key', ignoreDuplicates: true }
            );
        }

        if (fastify.pgBoss) {
            await fastify.pgBoss.send(
                GENERATE_QUOTATION_PDF_QUEUE,
                {
                    organizationId,
                    quotationId,
                    channels: Array.from(channels),
                },
                { singletonKey: `quotation-pdf:${quotationId}` }
            );
        }
    }

    const priceChangeNotice =
        finalPriceChanges.length > 0
            ? ` Nota: ${finalPriceChanges
                  .map((pc) => `${pc.productName} actualizó su precio de $${pc.oldPrice} a $${pc.newPrice}`)
                  .join('; ')}.`
            : '';

    return {
        ok: true,
        alreadyEmitted: Boolean(emitResult.alreadyEmitted),
        quotationId: emitResult.quotationId ?? quotationId,
        folio: emitResult.folio,
        validUntil: emitResult.validUntil ?? validUntil,
        currency: totals.currency,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        spokenTotal: spoken.spokenTotal,
        priceChanges: finalPriceChanges,
        message: `Listo, su cotización quedó emitida con el folio ${emitResult.folio} por un total de ${spoken.spokenTotal}.${priceChangeNotice}`,
    };
}

export default quotationToolRoutes;
