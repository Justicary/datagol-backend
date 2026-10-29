import { z } from 'zod';
import { ALL_QUOTATION_STATUSES } from '../types/quotation-status.js';
import { ALL_QUOTATION_EMAIL_SENDERS, ALL_QUOTATION_DELIVERY_CHANNELS } from '../types/quotation-delivery.js';

export const quotationOrgParamsSchema = z.object({
    id: z.string().uuid(),
});

export const quotationIdParamsSchema = z.object({
    id: z.string().uuid(),
    quotationId: z.string().uuid(),
});

export const quotationContactParamsSchema = z.object({
    id: z.string().uuid(),
    contactId: z.string().uuid(),
});

export const listQuotationsQuerySchema = z.object({
    status: z.enum(ALL_QUOTATION_STATUSES as unknown as [string, ...string[]]).optional(),
    from: z.string().trim().optional(),
    to: z.string().trim().optional(),
    contactId: z.string().uuid().optional(),
    q: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const createQuotationBodySchema = z.object({
    contactId: z.string().uuid(),
    notes: z.string().trim().max(2000).nullable().optional(),
    termsText: z.string().trim().max(4000).nullable().optional(),
});

export const quotationDraftItemInputSchema = z
    .object({
        variantId: z.string().uuid().optional(),
        sku: z.string().trim().min(1).max(120).optional(),
        quantity: z.number().positive().max(999999),
        discountAmount: z.number().min(0).max(999999999).default(0),
        description: z.string().trim().max(1000).nullable().optional(),
    })
    .refine((val) => Boolean(val.variantId || val.sku), {
        message: 'Cada partida requiere variantId o sku.',
    });

export const replaceQuotationItemsBodySchema = z.object({
    items: z.array(quotationDraftItemInputSchema).min(0).max(200),
    notes: z.string().trim().max(2000).nullable().optional(),
    termsText: z.string().trim().max(4000).nullable().optional(),
});

export const emitQuotationBodySchema = z.object({
    customerName: z.string().trim().min(1).max(200).optional(),
    customerEmail: z.string().trim().email().max(254).nullable().optional(),
    customerPhone: z.string().trim().min(7).max(30).nullable().optional(),
    customerBusinessName: z.string().trim().max(200).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    termsText: z.string().trim().max(4000).nullable().optional(),
    channels: z
        .array(z.enum(ALL_QUOTATION_DELIVERY_CHANNELS as unknown as [string, ...string[]]))
        .max(2)
        .default([]),
});

export const sendQuotationBodySchema = z.object({
    channels: z
        .array(z.enum(ALL_QUOTATION_DELIVERY_CHANNELS as unknown as [string, ...string[]]))
        .min(1)
        .max(2),
});

export const updateQuotationStatusBodySchema = z.object({
    status: z.enum(['aceptada', 'rechazada', 'cancelada']),
    reason: z.string().trim().max(1000).nullable().optional(),
});

export const reviseQuotationBodySchema = z.object({
    reason: z.string().trim().max(1000).nullable().optional(),
});

export const exportQuotationsQuerySchema = z.object({
    format: z.enum(['json', 'csv', 'xlsx']).default('json'),
    from: z.string().trim().optional(),
    to: z.string().trim().optional(),
    status: z.enum(ALL_QUOTATION_STATUSES as unknown as [string, ...string[]]).optional(),
});

export const updateQuotationSettingsBodySchema = z.object({
    folioPrefix: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9]{1,8}$/, 'El prefijo de folio debe tener de 1 a 8 caracteres alfanuméricos en mayúsculas.')
        .optional(),
    validityDays: z.number().int().min(1).max(365).optional(),
    cartTtlHours: z.number().int().min(24).max(2160).optional(),
    maxItems: z.number().int().min(1).max(200).optional(),
    termsText: z.string().trim().max(4000).nullable().optional(),
    notesDefault: z.string().trim().max(2000).nullable().optional(),
    emailSender: z.enum(ALL_QUOTATION_EMAIL_SENDERS as unknown as [string, ...string[]]).optional(),
    emailAccountId: z.string().uuid().nullable().optional(),
    whatsappTemplateName: z.string().trim().max(200).nullable().optional(),
});

export const catalogSearchQuerySchema = z.object({
    q: z.string().trim().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(20).default(10),
});
