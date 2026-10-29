import ExcelJS from 'exceljs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuthenticatedUser } from '../lib/organization-auth.js';
import { getPermissionsForUser } from '../services/permission-service.js';
import { isFeatureEnabled } from '../services/entitlements.js';
import { normalizePhoneE164 } from '../services/phone-normalization.js';
import { calculateQuotationTotals, type QuotationLineInput } from '../services/quotations/quotation-math.js';
import { createQuotationPdfSignedUrl } from '../services/quotations/quotation-pdf.js';
import { generateQuotationPdfHandler } from '../jobs/generate-quotation-pdf.js';
import { DELIVER_QUOTATION_QUEUE, deliverQuotationHandler } from '../jobs/deliver-quotation.js';
import { emitDraftQuotation } from './tools/quotation.js';
import { PERMISSION_KEYS } from '../types/permission-keys.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { QUOTATION_STATUSES } from '../types/quotation-status.js';
import { QUOTATION_ORIGINS } from '../types/quotation-origin.js';
import { QUOTATION_EVENT_TYPES } from '../types/quotation-event-type.js';
import { QUOTATION_DELIVERY_STATUSES } from '../types/quotation-delivery.js';
import type { CatalogItemType } from '../types/catalog-item-type.js';
import type { BillingPeriod } from '../types/billing-period.js';
import {
    quotationOrgParamsSchema,
    quotationIdParamsSchema,
    quotationContactParamsSchema,
    listQuotationsQuerySchema,
    createQuotationBodySchema,
    replaceQuotationItemsBodySchema,
    emitQuotationBodySchema,
    sendQuotationBodySchema,
    updateQuotationStatusBodySchema,
    reviseQuotationBodySchema,
    exportQuotationsQuerySchema,
    updateQuotationSettingsBodySchema,
    catalogSearchQuerySchema,
} from '../schemas/quotation.js';

interface AuthContext {
    userId: string;
    jwt: string;
    organizationId: string;
}

const FEATURE_DISABLED_MESSAGE =
    'El módulo de cotizaciones no está habilitado para esta organización. Contacte a soporte o actualice su plan.';

const MAX_EXPORT_QUOTATIONS = 2000;

function escapeCsvCell(val: unknown): string {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (/[",\r\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

export async function organizationQuotationsRoutes(fastify: FastifyInstance): Promise<void> {
    async function authorizeOrg(
        request: FastifyRequest,
        reply: FastifyReply,
        requiredPermission: string
    ): Promise<AuthContext | null> {
        const paramsResult = quotationOrgParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: 'El parámetro de ruta "id" debe ser un UUID válido.',
            });
            return null;
        }
        const organizationId = paramsResult.data.id;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const permissions = await getPermissionsForUser(organizationId, auth.userId, auth.jwt);
        if (!permissions.has(requiredPermission)) {
            reply.status(403).send({
                success: false,
                error: 'Forbidden',
                code: 'PERMISSION_DENIED',
                message: `No tiene el permiso "${requiredPermission}" en esta organización, o no pertenece a ella.`,
                requiredPermission,
            });
            return null;
        }

        const featureEnabled = await isFeatureEnabled(organizationId, FEATURE_KEYS.QUOTATIONS);
        if (!featureEnabled) {
            reply.status(403).send({
                success: false,
                error: 'Forbidden',
                code: 'FEATURE_DISABLED',
                message: FEATURE_DISABLED_MESSAGE,
            });
            return null;
        }

        return { userId: auth.userId, jwt: auth.jwt, organizationId };
    }

    // 1. GET /api/organizations/:id/quotations — Lista paginada con filtros
    fastify.get('/api/organizations/:id/quotations', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.VIEW_QUOTATIONS);
        if (!ctx) return;

        const queryResult = listQuotationsQuerySchema.safeParse(request.query ?? {});
        if (!queryResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: 'Parámetros de consulta inválidos.',
                details: queryResult.error.issues,
            });
        }

        const { status, from, to, contactId, q, page, limit } = queryResult.data;
        const offset = (page - 1) * limit;

        let query = fastify.supabaseAdmin
            .from('quotations')
            .select('*', { count: 'exact' })
            .eq('organization_id', ctx.organizationId);

        if (status) {
            query = query.eq('status', status);
        }
        if (contactId) {
            query = query.eq('contact_id', contactId);
        }
        if (from) {
            query = query.gte('created_at', from);
        }
        if (to) {
            query = query.lte('created_at', to);
        }
        if (q) {
            const safeQ = q.replace(/[,%()]/g, ' ').trim();
            if (safeQ) {
                query = query.or(
                    `folio.ilike.%${safeQ}%,customer_name.ilike.%${safeQ}%,customer_email.ilike.%${safeQ}%,customer_phone_e164.ilike.%${safeQ}%`
                );
            }
        }

        const { data: rows, count, error } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            return reply.status(500).send({
                success: false,
                error: 'DatabaseError',
                message: error.message,
            });
        }

        return reply.status(200).send({
            success: true,
            quotations: rows ?? [],
            pagination: {
                page,
                limit,
                total: count ?? 0,
                totalPages: Math.ceil((count ?? 0) / limit),
            },
        });
    });

    // 2. GET /api/organizations/:id/quotations/metrics — Métricas de cotizaciones (Fase I.1)
    fastify.get('/api/organizations/:id/quotations/metrics', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.VIEW_QUOTATIONS);
        if (!ctx) return;

        const [{ data: events }, { data: quotations }, { data: items }, { data: failedDeliveries }] =
            await Promise.all([
                fastify.supabaseAdmin
                    .from('quotation_events')
                    .select('event_type')
                    .eq('organization_id', ctx.organizationId),
                fastify.supabaseAdmin
                    .from('quotations')
                    .select('id, status, total')
                    .eq('organization_id', ctx.organizationId),
                fastify.supabaseAdmin
                    .from('quotation_items')
                    .select('sku, product_name, item_type, quantity, line_total')
                    .eq('organization_id', ctx.organizationId),
                fastify.supabaseAdmin
                    .from('quotation_deliveries')
                    .select('channel, status')
                    .eq('organization_id', ctx.organizationId)
                    .eq('status', QUOTATION_DELIVERY_STATUSES.ERROR),
            ]);

        let cartsCreated = 0;
        let cartsResumed = 0;
        for (const ev of events ?? []) {
            if (ev.event_type === QUOTATION_EVENT_TYPES.CARRITO_CREADO) cartsCreated += 1;
            if (ev.event_type === QUOTATION_EVENT_TYPES.CARRITO_RETOMADO) cartsResumed += 1;
        }

        const allQuots = quotations ?? [];
        const emittedSet = new Set<string>([
            QUOTATION_STATUSES.EMITIDA,
            QUOTATION_STATUSES.ENVIADA,
            QUOTATION_STATUSES.ACEPTADA,
            QUOTATION_STATUSES.RECHAZADA,
            QUOTATION_STATUSES.VENCIDA,
            QUOTATION_STATUSES.CONVERTIDA,
        ]);
        const emittedQuots = allQuots.filter((q) => emittedSet.has(q.status));
        const acceptedQuots = allQuots.filter(
            (q) => q.status === QUOTATION_STATUSES.ACEPTADA || q.status === QUOTATION_STATUSES.CONVERTIDA
        );
        const abandonedQuots = allQuots.filter((q) => q.status === QUOTATION_STATUSES.ABANDONADA);

        const totalCarts = Math.max(cartsCreated, allQuots.length);
        const conversionCartToEmittedPct =
            totalCarts > 0 ? Math.round((emittedQuots.length / totalCarts) * 10000) / 100 : 0;
        const conversionEmittedToAcceptedPct =
            emittedQuots.length > 0
                ? Math.round((acceptedQuots.length / emittedQuots.length) * 10000) / 100
                : 0;
        const abandonmentRatePct =
            totalCarts > 0 ? Math.round((abandonedQuots.length / totalCarts) * 10000) / 100 : 0;

        const sumEmittedTotal = emittedQuots.reduce((acc, q) => acc + Number(q.total ?? 0), 0);
        const averageTicket =
            emittedQuots.length > 0 ? Math.round((sumEmittedTotal / emittedQuots.length) * 100) / 100 : 0;

        const bySku = new Map<
            string,
            { sku: string; productName: string; itemType: string; totalQuantity: number; totalAmount: number; quoteCount: number }
        >();
        for (const it of items ?? []) {
            const sku = String(it.sku);
            const cur = bySku.get(sku) ?? {
                sku,
                productName: String(it.product_name),
                itemType: String(it.item_type ?? 'producto'),
                totalQuantity: 0,
                totalAmount: 0,
                quoteCount: 0,
            };
            cur.totalQuantity += Number(it.quantity ?? 0);
            cur.totalAmount = Math.round((cur.totalAmount + Number(it.line_total ?? 0)) * 100) / 100;
            cur.quoteCount += 1;
            bySku.set(sku, cur);
        }

        const topQuotedItems = Array.from(bySku.values())
            .sort((a, b) => b.quoteCount - a.quoteCount || b.totalQuantity - a.totalQuantity)
            .slice(0, 5);

        const failedDeliveriesByChannel = { email: 0, whatsapp: 0 };
        for (const fd of failedDeliveries ?? []) {
            if (fd.channel === 'email') failedDeliveriesByChannel.email += 1;
            if (fd.channel === 'whatsapp') failedDeliveriesByChannel.whatsapp += 1;
        }

        return reply.status(200).send({
            success: true,
            metrics: {
                cartsCreated,
                cartsResumed,
                quotationsEmitted: emittedQuots.length,
                quotationsAccepted: acceptedQuots.length,
                quotationsAbandoned: abandonedQuots.length,
                conversionCartToEmittedPct,
                conversionEmittedToAcceptedPct,
                abandonmentRatePct,
                averageTicket,
                topQuotedItems,
                failedDeliveriesByChannel,
            },
        });
    });

    // 3. GET /api/organizations/:id/quotations/export — Exportación JSON v1, CSV y XLSX (Fase H.1)
    fastify.get('/api/organizations/:id/quotations/export', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.EXPORT_DATA);
        if (!ctx) return;

        const queryResult = exportQuotationsQuerySchema.safeParse(request.query ?? {});
        if (!queryResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: 'Parámetros de exportación inválidos.',
                details: queryResult.error.issues,
            });
        }

        const { format, from, to, status } = queryResult.data;

        let qQuery = fastify.supabaseAdmin
            .from('quotations')
            .select('*')
            .eq('organization_id', ctx.organizationId)
            .order('created_at', { ascending: false })
            .limit(MAX_EXPORT_QUOTATIONS);

        if (status) {
            qQuery = qQuery.eq('status', status);
        }
        if (from) {
            qQuery = qQuery.gte('created_at', from);
        }
        if (to) {
            qQuery = qQuery.lte('created_at', to);
        }

        const { data: quotations, error: qErr } = await qQuery;
        if (qErr) {
            return reply.status(500).send({ success: false, error: 'DatabaseError', message: qErr.message });
        }

        const quotationList = quotations ?? [];
        const quotationIds = quotationList.map((q) => String(q.id));

        const itemsByQuotation = new Map<string, Record<string, unknown>[]>();
        if (quotationIds.length > 0) {
            const { data: allItems } = await fastify.supabaseAdmin
                .from('quotation_items')
                .select('*')
                .eq('organization_id', ctx.organizationId)
                .in('quotation_id', quotationIds)
                .order('line_number', { ascending: true });

            for (const item of allItems ?? []) {
                const qId = String(item.quotation_id);
                const list = itemsByQuotation.get(qId) ?? [];
                list.push(item as Record<string, unknown>);
                itemsByQuotation.set(qId, list);
            }

            // Registrar evento `exportada` en la primera cotización del lote para trazabilidad
            await fastify.supabaseAdmin.from('quotation_events').insert({
                organization_id: ctx.organizationId,
                quotation_id: quotationIds[0],
                event_type: QUOTATION_EVENT_TYPES.EXPORTADA,
                actor_user_id: ctx.userId,
                payload: {
                    format,
                    count: quotationIds.length,
                    status: status ?? null,
                    from: from ?? null,
                    to: to ?? null,
                },
            });
        }

        if (format === 'json') {
            return reply.status(200).send({
                schema: 'datagol.quotation.v1',
                exportedAt: new Date().toISOString(),
                organizationId: ctx.organizationId,
                count: quotationList.length,
                quotations: quotationList.map((q) => ({
                    id: q.id,
                    organizationId: q.organization_id,
                    contactId: q.contact_id,
                    folio: q.folio,
                    folioYear: q.folio_year,
                    folioNumber: q.folio_number,
                    revisionOfId: q.revision_of_id,
                    revisionNumber: q.revision_number,
                    status: q.status,
                    origin: q.origin,
                    customer: {
                        name: q.customer_name,
                        email: q.customer_email,
                        phoneE164: q.customer_phone_e164,
                        businessName: q.customer_business_name,
                    },
                    currency: q.currency,
                    subtotal: Number(q.subtotal ?? 0),
                    discountTotal: Number(q.discount_total ?? 0),
                    taxTotal: Number(q.tax_total ?? 0),
                    total: Number(q.total ?? 0),
                    totalsByBilling: q.totals_by_billing,
                    taxBreakdown: q.tax_breakdown,
                    issuedAt: q.issued_at,
                    validUntil: q.valid_until,
                    items: (itemsByQuotation.get(String(q.id)) ?? []).map((it) => ({
                        id: it.id,
                        lineNumber: it.line_number,
                        variantId: it.variant_id,
                        productId: it.product_id,
                        catalogId: it.catalog_id,
                        sku: it.sku,
                        externalId: it.external_id,
                        satProductKey: it.sat_product_key,
                        satUnitKey: it.sat_unit_key,
                        item_type: it.item_type,
                        billing_period: it.billing_period,
                        sat_unit_key: it.sat_unit_key,
                        productName: it.product_name,
                        presentation: it.presentation,
                        description: it.description,
                        quantity: Number(it.quantity ?? 0),
                        unitPrice: Number(it.unit_price ?? 0),
                        priceIncludesTax: Boolean(it.price_includes_tax),
                        taxRate: Number(it.tax_rate ?? 0),
                        discountAmount: Number(it.discount_amount ?? 0),
                        lineSubtotal: Number(it.line_subtotal ?? 0),
                        lineTax: Number(it.line_tax ?? 0),
                        lineTotal: Number(it.line_total ?? 0),
                    })),
                })),
            });
        }

        const headers = [
            'quotation_id',
            'folio',
            'status',
            'issued_at',
            'valid_until',
            'customer_name',
            'customer_email',
            'customer_phone_e164',
            'currency',
            'line_number',
            'sku',
            'product_name',
            'presentation',
            'item_type',
            'billing_period',
            'sat_product_key',
            'sat_unit_key',
            'quantity',
            'unit_price',
            'discount_amount',
            'line_subtotal',
            'line_tax',
            'line_total',
            'quotation_total',
        ];

        const flatRows: Array<Array<string | number | null>> = [];
        for (const q of quotationList) {
            const qItems = itemsByQuotation.get(String(q.id)) ?? [];
            if (qItems.length === 0) {
                flatRows.push([
                    String(q.id),
                    (q.folio as string | null) ?? '',
                    String(q.status),
                    (q.issued_at as string | null) ?? '',
                    (q.valid_until as string | null) ?? '',
                    (q.customer_name as string | null) ?? '',
                    (q.customer_email as string | null) ?? '',
                    (q.customer_phone_e164 as string | null) ?? '',
                    String(q.currency ?? 'MXN'),
                    0,
                    '',
                    '',
                    '',
                    '',
                    '',
                    '',
                    '',
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    Number(q.total ?? 0),
                ]);
            } else {
                for (const it of qItems) {
                    flatRows.push([
                        String(q.id),
                        (q.folio as string | null) ?? '',
                        String(q.status),
                        (q.issued_at as string | null) ?? '',
                        (q.valid_until as string | null) ?? '',
                        (q.customer_name as string | null) ?? '',
                        (q.customer_email as string | null) ?? '',
                        (q.customer_phone_e164 as string | null) ?? '',
                        String(q.currency ?? 'MXN'),
                        Number(it.line_number ?? 1),
                        String(it.sku ?? ''),
                        String(it.product_name ?? ''),
                        (it.presentation as string | null) ?? '',
                        String(it.item_type ?? 'producto'),
                        String(it.billing_period ?? 'unico'),
                        (it.sat_product_key as string | null) ?? '',
                        (it.sat_unit_key as string | null) ?? '',
                        Number(it.quantity ?? 0),
                        Number(it.unit_price ?? 0),
                        Number(it.discount_amount ?? 0),
                        Number(it.line_subtotal ?? 0),
                        Number(it.line_tax ?? 0),
                        Number(it.line_total ?? 0),
                        Number(q.total ?? 0),
                    ]);
                }
            }
        }

        if (format === 'csv') {
            const csvLines = [
                headers.join(','),
                ...flatRows.map((row) => row.map(escapeCsvCell).join(',')),
            ];
            reply.header('Content-Type', 'text/csv; charset=utf-8');
            reply.header('Content-Disposition', 'attachment; filename="cotizaciones.csv"');
            return reply.status(200).send(csvLines.join('\n'));
        }

        // XLSX con exceljs
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Cotizaciones');
        sheet.addRow(headers);
        for (const r of flatRows) {
            sheet.addRow(r);
        }
        const buffer = await workbook.xlsx.writeBuffer();
        reply.header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        reply.header('Content-Disposition', 'attachment; filename="cotizaciones.xlsx"');
        return reply.status(200).send(Buffer.from(buffer));
    });

    // 4. GET /api/organizations/:id/quotations/:quotationId — Detalle + partidas + entregas + eventos
    fastify.get('/api/organizations/:id/quotations/:quotationId', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.VIEW_QUOTATIONS);
        if (!ctx) return;

        const paramsResult = quotationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: 'Parámetros de ruta inválidos.',
            });
        }
        const { quotationId } = paramsResult.data;

        const { data: quotation, error: qErr } = await fastify.supabaseAdmin
            .from('quotations')
            .select('*')
            .eq('id', quotationId)
            .eq('organization_id', ctx.organizationId)
            .maybeSingle();

        if (qErr || !quotation) {
            return reply.status(404).send({
                success: false,
                error: 'NotFound',
                message: 'Cotización no encontrada.',
            });
        }

        const [{ data: items }, { data: deliveries }, { data: events }] = await Promise.all([
            fastify.supabaseAdmin
                .from('quotation_items')
                .select('*')
                .eq('quotation_id', quotationId)
                .eq('organization_id', ctx.organizationId)
                .order('line_number', { ascending: true }),
            fastify.supabaseAdmin
                .from('quotation_deliveries')
                .select('*')
                .eq('quotation_id', quotationId)
                .eq('organization_id', ctx.organizationId)
                .order('created_at', { ascending: false }),
            fastify.supabaseAdmin
                .from('quotation_events')
                .select('*')
                .eq('quotation_id', quotationId)
                .eq('organization_id', ctx.organizationId)
                .order('created_at', { ascending: true }),
        ]);

        return reply.status(200).send({
            success: true,
            quotation,
            items: items ?? [],
            deliveries: deliveries ?? [],
            events: events ?? [],
        });
    });

    // 5. GET /api/organizations/:id/quotations/:quotationId/pdf — URL firmada corta
    fastify.get('/api/organizations/:id/quotations/:quotationId/pdf', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.VIEW_QUOTATIONS);
        if (!ctx) return;

        const paramsResult = quotationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: 'Parámetros de ruta inválidos.',
            });
        }
        const { quotationId } = paramsResult.data;

        const { data: quotation } = await fastify.supabaseAdmin
            .from('quotations')
            .select('id, status, folio, pdf_storage_path')
            .eq('id', quotationId)
            .eq('organization_id', ctx.organizationId)
            .maybeSingle();

        if (!quotation) {
            return reply.status(404).send({
                success: false,
                error: 'NotFound',
                message: 'Cotización no encontrada.',
            });
        }

        if (!quotation.folio || quotation.status === QUOTATION_STATUSES.BORRADOR) {
            return reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: 'La cotización aún está en borrador y no tiene PDF emitido.',
            });
        }

        let storagePath = quotation.pdf_storage_path as string | null;
        if (!storagePath) {
            const genRes = await generateQuotationPdfHandler(fastify, {
                organizationId: ctx.organizationId,
                quotationId,
            });
            storagePath = genRes.storagePath ?? null;
        }

        if (!storagePath) {
            return reply.status(500).send({
                success: false,
                error: 'PdfError',
                message: 'No se pudo obtener la ruta del PDF de la cotización.',
            });
        }

        const signedUrl = await createQuotationPdfSignedUrl(fastify, storagePath, 900);
        if (!signedUrl) {
            return reply.status(500).send({
                success: false,
                error: 'StorageError',
                message: 'No se pudo generar el enlace firmado del PDF.',
            });
        }

        return reply.status(200).send({
            success: true,
            folio: quotation.folio,
            signedUrl,
            expiresInSeconds: 900,
        });
    });

    // 6. GET /api/organizations/:id/contacts/:contactId/quotations — Historial y carrito abierto del contacto (CRM)
    fastify.get('/api/organizations/:id/contacts/:contactId/quotations', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.VIEW_QUOTATIONS);
        if (!ctx) return;

        const paramsResult = quotationContactParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: 'Parámetros de ruta inválidos.',
            });
        }
        const { contactId } = paramsResult.data;

        const { data: quotations, error } = await fastify.supabaseAdmin
            .from('quotations')
            .select('*')
            .eq('organization_id', ctx.organizationId)
            .eq('contact_id', contactId)
            .order('created_at', { ascending: false });

        if (error) {
            return reply.status(500).send({ success: false, error: 'DatabaseError', message: error.message });
        }

        const list = quotations ?? [];
        const openDraft = list.find((q) => q.status === QUOTATION_STATUSES.BORRADOR) ?? null;
        let openDraftItems: unknown[] = [];

        if (openDraft) {
            const { data: draftItems } = await fastify.supabaseAdmin
                .from('quotation_items')
                .select('*')
                .eq('quotation_id', openDraft.id)
                .eq('organization_id', ctx.organizationId)
                .order('line_number', { ascending: true });
            openDraftItems = draftItems ?? [];
        }

        return reply.status(200).send({
            success: true,
            openDraft: openDraft ? { ...openDraft, items: openDraftItems } : null,
            quotations: list,
        });
    });

    // 7. POST /api/organizations/:id/quotations — Crear borrador para un contactId (409 si ya tiene uno)
    fastify.post('/api/organizations/:id/quotations', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.MANAGE_QUOTATIONS);
        if (!ctx) return;

        const bodyResult = createQuotationBodySchema.safeParse(request.body ?? {});
        if (!bodyResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: 'Datos inválidos para crear cotización.',
                details: bodyResult.error.issues,
            });
        }

        const { contactId, notes, termsText } = bodyResult.data;

        // Verificar que el contacto pertenezca a esta organización
        const { data: contact } = await fastify.supabaseAdmin
            .from('contacts')
            .select('id, full_name, email, phone_e164, business_name')
            .eq('id', contactId)
            .eq('organization_id', ctx.organizationId)
            .maybeSingle();

        if (!contact) {
            return reply.status(404).send({
                success: false,
                error: 'NotFound',
                message: 'El contacto indicado no existe en esta organización.',
            });
        }

        // Verificar si ya tiene un borrador abierto
        const { data: existingDraft } = await fastify.supabaseAdmin
            .from('quotations')
            .select('id')
            .eq('organization_id', ctx.organizationId)
            .eq('contact_id', contactId)
            .eq('status', QUOTATION_STATUSES.BORRADOR)
            .maybeSingle();

        if (existingDraft?.id) {
            return reply.status(409).send({
                success: false,
                error: 'Conflict',
                code: 'OPEN_DRAFT_EXISTS',
                existingQuotationId: existingDraft.id,
                message: 'El contacto ya tiene una cotización en borrador abierta.',
            });
        }

        const { data: created, error: createErr } = await fastify.supabaseAdmin
            .from('quotations')
            .insert({
                organization_id: ctx.organizationId,
                status: QUOTATION_STATUSES.BORRADOR,
                origin: QUOTATION_ORIGINS.DASHBOARD,
                contact_id: contactId,
                last_channel: 'dashboard',
                customer_name: (contact.full_name as string | null) ?? null,
                customer_email: (contact.email as string | null) ?? null,
                customer_phone_e164: (contact.phone_e164 as string | null) ?? null,
                customer_business_name: (contact.business_name as string | null) ?? null,
                notes: notes ?? null,
                terms_text: termsText ?? null,
                created_by: ctx.userId,
            })
            .select('*')
            .single();

        if (createErr || !created) {
            if (createErr?.code === '23505') {
                const { data: draftAfterRace } = await fastify.supabaseAdmin
                    .from('quotations')
                    .select('id')
                    .eq('organization_id', ctx.organizationId)
                    .eq('contact_id', contactId)
                    .eq('status', QUOTATION_STATUSES.BORRADOR)
                    .maybeSingle();
                return reply.status(409).send({
                    success: false,
                    error: 'Conflict',
                    code: 'OPEN_DRAFT_EXISTS',
                    existingQuotationId: draftAfterRace?.id ?? null,
                    message: 'El contacto ya tiene una cotización en borrador abierta.',
                });
            }
            return reply.status(500).send({
                success: false,
                error: 'DatabaseError',
                message: createErr?.message ?? 'Error al crear borrador.',
            });
        }

        await fastify.supabaseAdmin.from('quotation_events').insert({
            organization_id: ctx.organizationId,
            quotation_id: created.id,
            event_type: QUOTATION_EVENT_TYPES.CARRITO_CREADO,
            actor_user_id: ctx.userId,
            payload: { channel: 'dashboard', origin: 'dashboard' },
        });

        return reply.status(201).send({
            success: true,
            quotation: created,
        });
    });

    // 8. PUT /api/organizations/:id/quotations/:quotationId/items — Reemplazar partidas de un borrador (incluye descuentos)
    fastify.put('/api/organizations/:id/quotations/:quotationId/items', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.MANAGE_QUOTATIONS);
        if (!ctx) return;

        const paramsResult = quotationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'BadRequest', message: 'Parámetros inválidos.' });
        }
        const { quotationId } = paramsResult.data;

        const bodyResult = replaceQuotationItemsBodySchema.safeParse(request.body ?? {});
        if (!bodyResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: 'Partidas inválidas.',
                details: bodyResult.error.issues,
            });
        }

        const { items, notes, termsText } = bodyResult.data;

        const [{ data: quotation }, { data: settings }] = await Promise.all([
            fastify.supabaseAdmin
                .from('quotations')
                .select('*')
                .eq('id', quotationId)
                .eq('organization_id', ctx.organizationId)
                .maybeSingle(),
            fastify.supabaseAdmin
                .from('quotation_settings')
                .select('max_items')
                .eq('organization_id', ctx.organizationId)
                .maybeSingle(),
        ]);

        if (!quotation) {
            return reply.status(404).send({ success: false, error: 'NotFound', message: 'Cotización no encontrada.' });
        }

        if (quotation.status !== QUOTATION_STATUSES.BORRADOR) {
            return reply.status(400).send({
                success: false,
                error: 'InvalidStatus',
                message: 'Solo se pueden modificar las partidas de una cotización en borrador.',
            });
        }

        const maxItems = Number(settings?.max_items ?? 30);
        if (items.length > maxItems) {
            return reply.status(400).send({
                success: false,
                error: 'MaxItemsExceeded',
                message: `La cotización excede el límite máximo de ${maxItems} partidas.`,
            });
        }

        if (items.length === 0) {
            await fastify.supabaseAdmin
                .from('quotation_items')
                .delete()
                .eq('quotation_id', quotationId)
                .eq('organization_id', ctx.organizationId);

            const { data: updatedEmpty } = await fastify.supabaseAdmin
                .from('quotations')
                .update({
                    subtotal: 0,
                    discount_total: 0,
                    tax_total: 0,
                    total: 0,
                    totals_by_billing: [],
                    tax_breakdown: [],
                    ...(notes !== undefined ? { notes } : {}),
                    ...(termsText !== undefined ? { terms_text: termsText } : {}),
                    last_activity_at: new Date().toISOString(),
                })
                .eq('id', quotationId)
                .eq('organization_id', ctx.organizationId)
                .select('*')
                .single();

            return reply.status(200).send({
                success: true,
                quotation: updatedEmpty,
                items: [],
            });
        }

        const resolvedVariants: Array<{
            variant_id: string;
            product_id: string;
            catalog_id: string;
            sku: string;
            external_id: string | null;
            sat_product_key: string | null;
            sat_unit_key: string | null;
            item_type: CatalogItemType;
            billing_period: BillingPeriod;
            product_name: string;
            presentation: string | null;
            description: string | null;
            price: number;
            currency: string;
            price_includes_tax: boolean;
            tax_rate: number;
            quantity: number;
            discountAmount: number;
        }> = [];

        for (const inputItem of items) {
            let skuToResolve = inputItem.sku?.trim() || null;
            if (!skuToResolve && inputItem.variantId) {
                const { data: varRow } = await fastify.supabaseAdmin
                    .from('product_variants')
                    .select('sku')
                    .eq('id', inputItem.variantId)
                    .maybeSingle();
                skuToResolve = (varRow?.sku as string | undefined) ?? null;
            }

            if (!skuToResolve) {
                return reply.status(400).send({
                    success: false,
                    error: 'VariantNotFound',
                    message: 'No se encontró una de las variantes solicitadas.',
                });
            }

            const { data: resolved } = await fastify.supabaseAdmin
                .rpc('resolve_variant_for_org', {
                    p_org_id: ctx.organizationId,
                    p_sku: skuToResolve,
                })
                .maybeSingle();

            const resRow = resolved as Record<string, unknown> | null;
            if (!resRow || !resRow.variant_id || !resRow.is_available) {
                return reply.status(400).send({
                    success: false,
                    error: 'VariantUnavailable',
                    message: `La variante con SKU "${skuToResolve}" no está disponible para esta organización.`,
                });
            }

            if (resRow.is_inventoriable && resRow.stock_status === 'agotado') {
                return reply.status(400).send({
                    success: false,
                    error: 'OutOfStock',
                    message: `El producto "${resRow.product_name}" (${resRow.sku}) está agotado.`,
                });
            }

            if (resRow.price === null || resRow.price === undefined) {
                return reply.status(400).send({
                    success: false,
                    error: 'CustomPriceNotQuotable',
                    message: `La variante "${resRow.product_name}" (${resRow.sku}) requiere cotización a medida y no tiene precio fijo.`,
                });
            }

            resolvedVariants.push({
                variant_id: String(resRow.variant_id),
                product_id: String(resRow.product_id),
                catalog_id: String(resRow.catalog_id),
                sku: String(resRow.sku),
                external_id: (resRow.external_id as string | null) ?? null,
                sat_product_key: (resRow.sat_product_key as string | null) ?? null,
                sat_unit_key: (resRow.sat_unit_key as string | null) ?? null,
                item_type: (resRow.item_type as CatalogItemType) ?? 'producto',
                billing_period: (resRow.billing_period as BillingPeriod) ?? 'unico',
                product_name: String(resRow.product_name),
                presentation: (resRow.presentation as string | null) ?? null,
                description: inputItem.description ?? (resRow.description as string | null) ?? null,
                price: Number(resRow.price),
                currency: String(resRow.currency ?? 'MXN'),
                price_includes_tax: Boolean(resRow.price_includes_tax),
                tax_rate: Number(resRow.tax_rate ?? 0.16),
                quantity: inputItem.quantity,
                discountAmount: inputItem.discountAmount ?? 0,
            });
        }

        const mathInputs: QuotationLineInput[] = resolvedVariants.map((rv) => ({
            sku: rv.sku,
            productName: rv.product_name,
            presentation: rv.presentation,
            itemType: rv.item_type,
            billingPeriod: rv.billing_period,
            quantity: rv.quantity,
            unitPrice: rv.price,
            currency: rv.currency,
            priceIncludesTax: rv.price_includes_tax,
            taxRate: rv.tax_rate,
            discountAmount: rv.discountAmount,
        }));

        let totals;
        try {
            totals = calculateQuotationTotals(mathInputs);
        } catch (mathErr: unknown) {
            const msg = mathErr instanceof Error ? mathErr.message : String(mathErr);
            return reply.status(400).send({
                success: false,
                error: 'MathError',
                message: msg,
            });
        }

        await fastify.supabaseAdmin
            .from('quotation_items')
            .delete()
            .eq('quotation_id', quotationId)
            .eq('organization_id', ctx.organizationId);

        const rowsToInsert = resolvedVariants.map((rv, idx) => {
            const lineCalc = totals.lines[idx];
            return {
                quotation_id: quotationId,
                organization_id: ctx.organizationId,
                line_number: idx + 1,
                variant_id: rv.variant_id,
                product_id: rv.product_id,
                catalog_id: rv.catalog_id,
                sku: rv.sku,
                external_id: rv.external_id,
                sat_product_key: rv.sat_product_key,
                sat_unit_key: rv.sat_unit_key,
                item_type: rv.item_type,
                billing_period: rv.billing_period,
                product_name: rv.product_name,
                presentation: rv.presentation,
                description: rv.description,
                quantity: rv.quantity,
                unit_price: rv.price,
                price_includes_tax: rv.price_includes_tax,
                tax_rate: rv.tax_rate,
                discount_amount: lineCalc.discountAmount,
                line_subtotal: lineCalc.lineSubtotal,
                line_tax: lineCalc.lineTax,
                line_total: lineCalc.lineTotal,
            };
        });

        const { data: insertedItems, error: insErr } = await fastify.supabaseAdmin
            .from('quotation_items')
            .insert(rowsToInsert)
            .select('*')
            .order('line_number', { ascending: true });

        if (insErr) {
            return reply.status(500).send({ success: false, error: 'DatabaseError', message: insErr.message });
        }

        const { data: updatedQuotation, error: updErr } = await fastify.supabaseAdmin
            .from('quotations')
            .update({
                currency: totals.currency,
                subtotal: totals.subtotal,
                discount_total: totals.discountTotal,
                tax_total: totals.taxTotal,
                total: totals.total,
                totals_by_billing: totals.totalsByBilling,
                tax_breakdown: totals.taxBreakdown,
                ...(notes !== undefined ? { notes } : {}),
                ...(termsText !== undefined ? { terms_text: termsText } : {}),
                last_channel: 'dashboard',
                last_activity_at: new Date().toISOString(),
            })
            .eq('id', quotationId)
            .eq('organization_id', ctx.organizationId)
            .select('*')
            .single();

        if (updErr) {
            return reply.status(500).send({ success: false, error: 'DatabaseError', message: updErr.message });
        }

        return reply.status(200).send({
            success: true,
            quotation: updatedQuotation,
            items: insertedItems ?? [],
        });
    });

    // 9. POST /api/organizations/:id/quotations/:quotationId/emit — Emitir borrador
    fastify.post('/api/organizations/:id/quotations/:quotationId/emit', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.MANAGE_QUOTATIONS);
        if (!ctx) return;

        const paramsResult = quotationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'BadRequest', message: 'Parámetros inválidos.' });
        }
        const { quotationId } = paramsResult.data;

        const bodyResult = emitQuotationBodySchema.safeParse(request.body ?? {});
        if (!bodyResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: 'Parámetros de emisión inválidos.',
                details: bodyResult.error.issues,
            });
        }

        const { customerName, customerEmail, customerPhone, customerBusinessName, notes, termsText, channels } =
            bodyResult.data;

        const { data: quotation } = await fastify.supabaseAdmin
            .from('quotations')
            .select('*')
            .eq('id', quotationId)
            .eq('organization_id', ctx.organizationId)
            .maybeSingle();

        if (!quotation) {
            return reply.status(404).send({ success: false, error: 'NotFound', message: 'Cotización no encontrada.' });
        }

        if (quotation.status === QUOTATION_STATUSES.BORRADOR && (notes !== undefined || termsText !== undefined)) {
            await fastify.supabaseAdmin
                .from('quotations')
                .update({
                    ...(notes !== undefined ? { notes } : {}),
                    ...(termsText !== undefined ? { terms_text: termsText } : {}),
                })
                .eq('id', quotationId)
                .eq('organization_id', ctx.organizationId);
        }

        let phoneE164 = (quotation.customer_phone_e164 as string | null) ?? null;
        if (customerPhone) {
            const norm = normalizePhoneE164(customerPhone);
            if (!norm.success || !norm.phoneE164) {
                return reply.status(400).send({
                    success: false,
                    error: 'InvalidPhone',
                    message: 'El teléfono del cliente no tiene un formato E.164 válido.',
                });
            }
            phoneE164 = norm.phoneE164;
        }

        const emitRes = await emitDraftQuotation(fastify, {
            organizationId: ctx.organizationId,
            quotationId,
            customer: {
                name: customerName || (quotation.customer_name as string | null) || 'Cliente',
                email: customerEmail !== undefined ? customerEmail : ((quotation.customer_email as string | null) ?? null),
                phoneE164,
                businessName:
                    customerBusinessName !== undefined
                        ? customerBusinessName
                        : ((quotation.customer_business_name as string | null) ?? null),
            },
            channels: channels as Array<'email' | 'whatsapp'>,
            actorUserId: ctx.userId,
        });

        if (!emitRes.ok) {
            return reply.status(400).send({
                success: false,
                error: emitRes.errorCode || 'EmitFailed',
                message: emitRes.message,
            });
        }

        return reply.status(200).send({
            success: true,
            ...emitRes,
        });
    });

    // 10. POST /api/organizations/:id/quotations/:quotationId/send — Reenviar por canal(es)
    fastify.post('/api/organizations/:id/quotations/:quotationId/send', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.MANAGE_QUOTATIONS);
        if (!ctx) return;

        const paramsResult = quotationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'BadRequest', message: 'Parámetros inválidos.' });
        }
        const { quotationId } = paramsResult.data;

        const bodyResult = sendQuotationBodySchema.safeParse(request.body ?? {});
        if (!bodyResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: 'Debe especificar al menos un canal válido (email o whatsapp).',
            });
        }

        const { data: quotation } = await fastify.supabaseAdmin
            .from('quotations')
            .select('*')
            .eq('id', quotationId)
            .eq('organization_id', ctx.organizationId)
            .maybeSingle();

        if (!quotation) {
            return reply.status(404).send({ success: false, error: 'NotFound', message: 'Cotización no encontrada.' });
        }

        if (quotation.status === QUOTATION_STATUSES.BORRADOR || quotation.status === QUOTATION_STATUSES.ABANDONADA) {
            return reply.status(400).send({
                success: false,
                error: 'InvalidStatus',
                message: 'Debe emitir la cotización antes de enviarla.',
            });
        }

        // Asegurar que exista el PDF antes de despachar
        if (!quotation.pdf_storage_path) {
            await generateQuotationPdfHandler(fastify, {
                organizationId: ctx.organizationId,
                quotationId,
            });
        }

        const deliveryIds: string[] = [];
        for (const ch of bodyResult.data.channels) {
            const recipient = ch === 'email' ? quotation.customer_email : quotation.customer_phone_e164;
            if (!recipient) {
                return reply.status(400).send({
                    success: false,
                    error: 'MissingRecipient',
                    message:
                        ch === 'email'
                            ? 'La cotización no tiene correo electrónico del destinatario.'
                            : 'La cotización no tiene teléfono del destinatario.',
                });
            }

            const { data: delRow, error: delErr } = await fastify.supabaseAdmin
                .from('quotation_deliveries')
                .insert({
                    organization_id: ctx.organizationId,
                    quotation_id: quotationId,
                    channel: ch,
                    recipient: String(recipient),
                    status: QUOTATION_DELIVERY_STATUSES.PENDIENTE,
                    idempotency_key: `manual-send:${quotationId}:${ch}:${Date.now()}`,
                })
                .select('id')
                .single();

            if (!delErr && delRow?.id) {
                deliveryIds.push(String(delRow.id));
                if (fastify.pgBoss) {
                    await fastify.pgBoss.send(DELIVER_QUOTATION_QUEUE, {
                        organizationId: ctx.organizationId,
                        deliveryId: String(delRow.id),
                    });
                } else {
                    await deliverQuotationHandler(fastify, {
                        organizationId: ctx.organizationId,
                        deliveryId: String(delRow.id),
                    });
                }
            }
        }

        return reply.status(200).send({
            success: true,
            deliveryIds,
        });
    });

    // 11. POST /api/organizations/:id/quotations/:quotationId/status — aceptada/rechazada/cancelada con reason
    fastify.post('/api/organizations/:id/quotations/:quotationId/status', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.MANAGE_QUOTATIONS);
        if (!ctx) return;

        const paramsResult = quotationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'BadRequest', message: 'Parámetros inválidos.' });
        }
        const { quotationId } = paramsResult.data;

        const bodyResult = updateQuotationStatusBodySchema.safeParse(request.body ?? {});
        if (!bodyResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: 'Estado o motivo inválido.',
                details: bodyResult.error.issues,
            });
        }

        const { status: newStatus, reason } = bodyResult.data;

        const { data: existing } = await fastify.supabaseAdmin
            .from('quotations')
            .select('id, status, total, currency, contact_id')
            .eq('id', quotationId)
            .eq('organization_id', ctx.organizationId)
            .maybeSingle();

        if (!existing) {
            return reply.status(404).send({ success: false, error: 'NotFound', message: 'Cotización no encontrada.' });
        }

        const nowIso = new Date().toISOString();
        const patch: Record<string, unknown> = {
            status: newStatus,
            status_reason: reason ?? null,
        };
        if (newStatus === QUOTATION_STATUSES.ACEPTADA) patch.accepted_at = nowIso;
        if (newStatus === QUOTATION_STATUSES.RECHAZADA) patch.rejected_at = nowIso;
        if (newStatus === QUOTATION_STATUSES.CANCELADA) patch.cancelled_at = nowIso;

        const { data: updated, error: updErr } = await fastify.supabaseAdmin
            .from('quotations')
            .update(patch)
            .eq('id', quotationId)
            .eq('organization_id', ctx.organizationId)
            .select('*')
            .single();

        if (updErr || !updated) {
            return reply.status(400).send({
                success: false,
                error: 'InvalidTransition',
                message: updErr?.message ?? 'Transición de estado no permitida.',
            });
        }

        await fastify.supabaseAdmin.from('quotation_events').insert({
            organization_id: ctx.organizationId,
            quotation_id: quotationId,
            event_type: newStatus,
            actor_user_id: ctx.userId,
            payload: {
                previous_status: existing.status,
                new_status: newStatus,
                reason: reason ?? null,
            },
        });

        // Aceptada -> sugiere `suggestedDealValue` (total inicial) sin escribir `contacts.deal_value` (AGENTS.md §6)
        const suggestedDealValue =
            newStatus === QUOTATION_STATUSES.ACEPTADA ? Number(updated.total ?? 0) : undefined;

        return reply.status(200).send({
            success: true,
            quotation: updated,
            ...(suggestedDealValue !== undefined ? { suggestedDealValue } : {}),
        });
    });

    // 12. POST /api/organizations/:id/quotations/:quotationId/revise — Crear revisión -R{n}
    fastify.post('/api/organizations/:id/quotations/:quotationId/revise', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.MANAGE_QUOTATIONS);
        if (!ctx) return;

        const paramsResult = quotationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'BadRequest', message: 'Parámetros inválidos.' });
        }
        const { quotationId } = paramsResult.data;

        const bodyResult = reviseQuotationBodySchema.safeParse(request.body ?? {});
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'BadRequest', message: 'Cuerpo inválido.' });
        }

        const { data: source } = await fastify.supabaseAdmin
            .from('quotations')
            .select('*')
            .eq('id', quotationId)
            .eq('organization_id', ctx.organizationId)
            .maybeSingle();

        if (!source) {
            return reply.status(404).send({ success: false, error: 'NotFound', message: 'Cotización no encontrada.' });
        }

        if (source.status === QUOTATION_STATUSES.BORRADOR || source.status === QUOTATION_STATUSES.ABANDONADA) {
            return reply.status(400).send({
                success: false,
                error: 'InvalidStatus',
                message: 'Solo se puede crear una revisión a partir de una cotización ya emitida.',
            });
        }

        if (!source.contact_id) {
            return reply.status(400).send({
                success: false,
                error: 'MissingContact',
                message: 'La cotización original ya no tiene un contacto activo asociado.',
            });
        }

        // Verificar que el contacto no tenga ya otro borrador abierto
        const { data: existingDraft } = await fastify.supabaseAdmin
            .from('quotations')
            .select('id')
            .eq('organization_id', ctx.organizationId)
            .eq('contact_id', source.contact_id)
            .eq('status', QUOTATION_STATUSES.BORRADOR)
            .maybeSingle();

        if (existingDraft?.id) {
            return reply.status(409).send({
                success: false,
                error: 'Conflict',
                code: 'OPEN_DRAFT_EXISTS',
                existingQuotationId: existingDraft.id,
                message: 'El contacto ya tiene un borrador abierto.',
            });
        }

        const rootId = (source.revision_of_id as string | null) ?? String(source.id);
        const { data: siblingRevs } = await fastify.supabaseAdmin
            .from('quotations')
            .select('revision_number')
            .eq('organization_id', ctx.organizationId)
            .or(`id.eq.${rootId},revision_of_id.eq.${rootId}`)
            .order('revision_number', { ascending: false })
            .limit(1);

        const maxRev = Number(siblingRevs?.[0]?.revision_number ?? source.revision_number ?? 0);
        const nextRevisionNumber = maxRev + 1;

        const { data: revDraft, error: revErr } = await fastify.supabaseAdmin
            .from('quotations')
            .insert({
                organization_id: ctx.organizationId,
                status: QUOTATION_STATUSES.BORRADOR,
                origin: QUOTATION_ORIGINS.REVISION,
                contact_id: source.contact_id,
                last_channel: 'dashboard',
                customer_name: source.customer_name,
                customer_email: source.customer_email,
                customer_phone_e164: source.customer_phone_e164,
                customer_business_name: source.customer_business_name,
                revision_of_id: rootId,
                revision_number: nextRevisionNumber,
                currency: source.currency,
                subtotal: source.subtotal,
                discount_total: source.discount_total,
                tax_total: source.tax_total,
                total: source.total,
                totals_by_billing: source.totals_by_billing,
                tax_breakdown: source.tax_breakdown,
                notes: source.notes,
                terms_text: source.terms_text,
                created_by: ctx.userId,
            })
            .select('*')
            .single();

        if (revErr || !revDraft) {
            return reply.status(500).send({
                success: false,
                error: 'DatabaseError',
                message: revErr?.message ?? 'Error al crear borrador de revisión.',
            });
        }

        // Copiar partidas de la cotización original al nuevo borrador de revisión
        const { data: sourceItems } = await fastify.supabaseAdmin
            .from('quotation_items')
            .select('*')
            .eq('quotation_id', quotationId)
            .eq('organization_id', ctx.organizationId)
            .order('line_number', { ascending: true });

        if (sourceItems && sourceItems.length > 0) {
            const copiedItems = sourceItems.map((it) => ({
                quotation_id: revDraft.id,
                organization_id: ctx.organizationId,
                line_number: it.line_number,
                variant_id: it.variant_id,
                product_id: it.product_id,
                catalog_id: it.catalog_id,
                sku: it.sku,
                external_id: it.external_id,
                sat_product_key: it.sat_product_key,
                sat_unit_key: it.sat_unit_key,
                item_type: it.item_type,
                billing_period: it.billing_period,
                product_name: it.product_name,
                presentation: it.presentation,
                description: it.description,
                quantity: it.quantity,
                unit_price: it.unit_price,
                price_includes_tax: it.price_includes_tax,
                tax_rate: it.tax_rate,
                discount_amount: it.discount_amount,
                line_subtotal: it.line_subtotal,
                line_tax: it.line_tax,
                line_total: it.line_total,
            }));
            await fastify.supabaseAdmin.from('quotation_items').insert(copiedItems);
        }

        await fastify.supabaseAdmin.from('quotation_events').insert([
            {
                organization_id: ctx.organizationId,
                quotation_id: quotationId,
                event_type: QUOTATION_EVENT_TYPES.REVISADA,
                actor_user_id: ctx.userId,
                payload: {
                    new_quotation_id: revDraft.id,
                    revision_number: nextRevisionNumber,
                    reason: bodyResult.data.reason ?? null,
                },
            },
            {
                organization_id: ctx.organizationId,
                quotation_id: revDraft.id,
                event_type: QUOTATION_EVENT_TYPES.CARRITO_CREADO,
                actor_user_id: ctx.userId,
                payload: {
                    origin: 'revision',
                    revision_of_id: rootId,
                    revision_number: nextRevisionNumber,
                },
            },
        ]);

        return reply.status(201).send({
            success: true,
            quotation: revDraft,
        });
    });

    // 13. GET /api/organizations/:id/quotation-settings — Obtener configuración
    fastify.get('/api/organizations/:id/quotation-settings', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.VIEW_QUOTATIONS);
        if (!ctx) return;

        const { data: settings } = await fastify.supabaseAdmin
            .from('quotation_settings')
            .select('*')
            .eq('organization_id', ctx.organizationId)
            .maybeSingle();

        return reply.status(200).send({
            success: true,
            settings: settings ?? {
                organization_id: ctx.organizationId,
                folio_prefix: 'COT',
                validity_days: 15,
                cart_ttl_hours: 168,
                max_items: 30,
                terms_text: null,
                notes_default: null,
                email_sender: 'auto',
                email_account_id: null,
                whatsapp_template_name: null,
            },
        });
    });

    // 14. PUT /api/organizations/:id/quotation-settings — Actualizar configuración
    fastify.put('/api/organizations/:id/quotation-settings', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.MANAGE_QUOTATIONS);
        if (!ctx) return;

        const bodyResult = updateQuotationSettingsBodySchema.safeParse(request.body ?? {});
        if (!bodyResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: 'Configuración de cotizaciones inválida.',
                details: bodyResult.error.issues,
            });
        }

        const b = bodyResult.data;
        const upsertPayload: Record<string, unknown> = {
            organization_id: ctx.organizationId,
            updated_by: ctx.userId,
        };
        if (b.folioPrefix !== undefined) upsertPayload.folio_prefix = b.folioPrefix;
        if (b.validityDays !== undefined) upsertPayload.validity_days = b.validityDays;
        if (b.cartTtlHours !== undefined) upsertPayload.cart_ttl_hours = b.cartTtlHours;
        if (b.maxItems !== undefined) upsertPayload.max_items = b.maxItems;
        if (b.termsText !== undefined) upsertPayload.terms_text = b.termsText;
        if (b.notesDefault !== undefined) upsertPayload.notes_default = b.notesDefault;
        if (b.emailSender !== undefined) upsertPayload.email_sender = b.emailSender;
        if (b.emailAccountId !== undefined) upsertPayload.email_account_id = b.emailAccountId;
        if (b.whatsappTemplateName !== undefined) upsertPayload.whatsapp_template_name = b.whatsappTemplateName;

        const { data: saved, error } = await fastify.supabaseAdmin
            .from('quotation_settings')
            .upsert(upsertPayload, { onConflict: 'organization_id' })
            .select('*')
            .single();

        if (error) {
            return reply.status(500).send({ success: false, error: 'DatabaseError', message: error.message });
        }

        return reply.status(200).send({
            success: true,
            settings: saved,
        });
    });

    // 15. GET /api/organizations/:id/catalog/search?q= — Buscador para el editor de borradores
    fastify.get('/api/organizations/:id/catalog/search', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.VIEW_QUOTATIONS);
        if (!ctx) return;

        const queryResult = catalogSearchQuerySchema.safeParse(request.query ?? {});
        if (!queryResult.success) {
            return reply.status(400).send({
                success: false,
                error: 'BadRequest',
                message: 'El parámetro "q" es obligatorio.',
            });
        }

        const { q, limit } = queryResult.data;
        const { data: results, error } = await fastify.supabaseAdmin.rpc('quotation_search_products', {
            p_org_id: ctx.organizationId,
            p_query: q,
            p_limit: limit,
        });

        if (error) {
            return reply.status(500).send({ success: false, error: 'DatabaseError', message: error.message });
        }

        return reply.status(200).send({
            success: true,
            items: results ?? [],
        });
    });
}

export default organizationQuotationsRoutes;
