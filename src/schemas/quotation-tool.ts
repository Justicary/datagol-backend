import { z } from 'zod';
import { ALL_CATALOG_ITEM_TYPES } from '../types/catalog-item-type.js';
import { ALL_BILLING_PERIODS } from '../types/billing-period.js';
import { ALL_QUOTATION_DELIVERY_CHANNELS } from '../types/quotation-delivery.js';

export const MAX_QUOTATION_SEARCH_RESULTS = 3;

/**
 * Preprocesador para parámetros opcionales enviados por ElevenLabs / Vapi.
 * En llamadas de voz o simulador web, variables dinámicas no pobladas (como system__caller_id)
 * llegan como literal `null` o `""`, lo cual rompe un `z.string().optional()` estricto con 400.
 */
const emptyOrNullToUndefined = (value: unknown) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    return value;
};

export const quotationSearchBodySchema = z.object({
    query: z.preprocess((val) => (val === null || val === undefined ? '' : String(val)), z.string().default('')),
    limit: z.preprocess(
        (val) => (val === null || val === undefined ? undefined : Number(val)),
        z.number().int().min(1).max(20).optional().default(MAX_QUOTATION_SEARCH_RESULTS)
    ),
});

export const quotationSearchResultItemSchema = z.object({
    sku: z.string(),
    productName: z.string(),
    presentation: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    itemType: z.enum(ALL_CATALOG_ITEM_TYPES),
    billingPeriod: z.enum(ALL_BILLING_PERIODS),
    price: z.number().nullable(),
    currency: z.string(),
    priceIncludesTax: z.boolean(),
    availabilityText: z.string().optional(),
    maintenanceSku: z.string().nullable().optional(),
    spokenPrice: z.string(),
});

export const quotationSearchResponseSchema = z.object({
    results: z.array(quotationSearchResultItemSchema),
    message: z.string().optional(),
});

export const quotationChannelSchema = z.enum(['voz', 'whatsapp', 'web']).optional().default('voz');

export const quotationCartSetItemBodySchema = z.object({
    conversationId: z.string().min(1),
    customerPhone: z.preprocess(emptyOrNullToUndefined, z.string().optional()),
    customerEmail: z.preprocess(emptyOrNullToUndefined, z.string().optional()),
    customerName: z.preprocess(emptyOrNullToUndefined, z.string().optional()),
    channel: z.preprocess(emptyOrNullToUndefined, quotationChannelSchema),
    sku: z.string().min(1),
    quantity: z.preprocess((val) => (typeof val === 'string' ? Number(val) : val), z.number().min(0)),
});

export const quotationCartRemoveItemBodySchema = z.object({
    conversationId: z.string().min(1),
    customerPhone: z.preprocess(emptyOrNullToUndefined, z.string().optional()),
    customerEmail: z.preprocess(emptyOrNullToUndefined, z.string().optional()),
    channel: z.preprocess(emptyOrNullToUndefined, quotationChannelSchema),
    sku: z.string().min(1),
});

export const quotationCartViewBodySchema = z.object({
    conversationId: z.string().min(1),
    customerPhone: z.preprocess(emptyOrNullToUndefined, z.string().optional()),
    customerEmail: z.preprocess(emptyOrNullToUndefined, z.string().optional()),
    channel: z.preprocess(emptyOrNullToUndefined, quotationChannelSchema),
});

export const quotationFinalizeBodySchema = z.object({
    conversationId: z.string().min(1),
    customerPhone: z.preprocess(emptyOrNullToUndefined, z.string().optional()),
    customerEmail: z.preprocess(emptyOrNullToUndefined, z.string().optional()),
    customerName: z.string().min(1),
    customerBusinessName: z.preprocess(emptyOrNullToUndefined, z.string().optional()),
    channel: z.preprocess(emptyOrNullToUndefined, quotationChannelSchema),
    channels: z.array(z.enum(ALL_QUOTATION_DELIVERY_CHANNELS)).min(1),
    notes: z.preprocess(emptyOrNullToUndefined, z.string().optional()),
});

export const quotationCartLineSchema = z.object({
    sku: z.string(),
    productName: z.string(),
    presentation: z.string().nullable().optional(),
    itemType: z.enum(ALL_CATALOG_ITEM_TYPES),
    billingPeriod: z.enum(ALL_BILLING_PERIODS),
    quantity: z.number(),
    unitPrice: z.number(),
    currency: z.string(),
    priceIncludesTax: z.boolean(),
    taxRate: z.number(),
    discountAmount: z.number().default(0),
    lineSubtotal: z.number(),
    lineTax: z.number(),
    lineTotal: z.number(),
});

export const suggestedComplementSchema = z
    .object({
        sku: z.string(),
        productName: z.string(),
        presentation: z.string().nullable().optional(),
        price: z.number(),
        currency: z.string(),
        billingPeriod: z.string(),
    })
    .nullable()
    .optional();

export const quotationCartResponseSchema = z.object({
    ok: z.boolean(),
    errorCode: z.string().optional(),
    quotationId: z.string().nullable().optional(),
    hasCart: z.boolean().optional(),
    resumed: z.boolean().optional(),
    currency: z.string().optional(),
    items: z.array(quotationCartLineSchema).default([]),
    totalsByBilling: z
        .array(
            z.object({
                billingPeriod: z.enum(ALL_BILLING_PERIODS),
                subtotal: z.number(),
                tax: z.number(),
                discount: z.number(),
                total: z.number(),
            })
        )
        .default([]),
    subtotal: z.number().optional(),
    taxTotal: z.number().optional(),
    total: z.number().optional(),
    spokenItems: z.string().optional(),
    spokenTotal: z.string().optional(),
    spokenSummary: z.string().optional(),
    suggestedComplement: suggestedComplementSchema,
    message: z.string().optional(),
});

export const priceChangeEntrySchema = z.object({
    sku: z.string(),
    productName: z.string(),
    oldPrice: z.number(),
    newPrice: z.number(),
});

export const quotationFinalizeResponseSchema = z.object({
    ok: z.boolean(),
    errorCode: z.string().optional(),
    alreadyEmitted: z.boolean().optional(),
    quotationId: z.string().optional(),
    folio: z.string().optional(),
    validUntil: z.string().nullable().optional(),
    currency: z.string().optional(),
    subtotal: z.number().optional(),
    taxTotal: z.number().optional(),
    total: z.number().optional(),
    spokenTotal: z.string().optional(),
    priceChanges: z.array(priceChangeEntrySchema).default([]),
    message: z.string(),
});
