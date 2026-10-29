import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import type { FastifyInstance } from 'fastify';
import { amountToLegalSpanish } from '../../lib/number-to-spanish-words.js';
import type { CatalogItemType } from '../../types/catalog-item-type.js';
import type { BillingPeriod } from '../../types/billing-period.js';

export const QUOTATIONS_BUCKET = 'quotations';
export const MAX_QUOTATION_PDF_ATTACH_BYTES = 7 * 1024 * 1024; // 7 MB (email.ts:522)
const MAX_QUOTATION_STORAGE_BYTES = 10 * 1024 * 1024; // 10 MB bucket limit

export interface QuotationPdfItem {
    lineNumber: number;
    sku: string;
    productName: string;
    variantName?: string | null;
    description?: string | null;
    itemType: CatalogItemType;
    billingPeriod: BillingPeriod;
    unitOfMeasure: string;
    quantity: number;
    unitPrice: number;
    discountAmount?: number;
    lineSubtotal: number;
    lineTax: number;
    lineTotal: number;
}

export interface QuotationPdfBillingBlock {
    subtotal: number;
    discountTotal?: number;
    taxTotal: number;
    total: number;
}

export interface QuotationPdfTaxBreakdownRow {
    ratePct: number;
    base: number;
    tax: number;
}

export interface QuotationPdfData {
    organizationName: string;
    organizationLegalName?: string | null;
    organizationTaxId?: string | null;
    organizationAddress?: string | null;
    organizationPhone?: string | null;
    organizationEmail?: string | null;
    primaryColor?: string;
    headerNote?: string | null;
    folio: string;
    revisionNumber?: number;
    emittedAt: string;
    validUntil: string | null;
    timezone?: string;
    currency: string;
    taxRatePct: number;
    customerName?: string | null;
    customerCompany?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    items: QuotationPdfItem[];
    subtotal: number;
    discountTotal: number;
    taxTotal: number;
    total: number;
    totalsByBilling?: Partial<Record<BillingPeriod, QuotationPdfBillingBlock>>;
    taxBreakdown?: QuotationPdfTaxBreakdownRow[];
    notes?: string | null;
    termsAndConditions?: string | null;
    footerNote?: string | null;
}

function formatMoney(amount: number, currency: string): string {
    const fixed = Number(amount || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    return `$${fixed} ${currency}`;
}

function formatBillingPeriodLabel(period: BillingPeriod): string {
    switch (period) {
        case 'mensual':
            return 'Mensual';
        case 'anual':
            return 'Anual';
        case 'unico':
        default:
            return 'Único';
    }
}

function formatDateInTimezone(isoOrDate: string | null | undefined, timezone = 'America/Mexico_City'): string {
    if (!isoOrDate) return '—';
    if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrDate)) {
        return isoOrDate;
    }
    try {
        const d = new Date(isoOrDate);
        if (Number.isNaN(d.getTime())) return isoOrDate;
        return new Intl.DateTimeFormat('es-MX', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(d);
    } catch {
        return isoOrDate;
    }
}

function sanitizeHexColor(color: string | undefined): string {
    if (!color) return '#1e3a8a';
    return /^#[0-9a-fA-F]{6}$/.test(color.trim()) ? color.trim() : '#1e3a8a';
}

/**
 * Genera el PDF de una cotización en memoria (función pura, sin red ni BD).
 * Incluye encabezado de organización, datos del cliente, tabla de partidas con
 * modalidad ("Único", "Mensual", "Anual"), repetición de encabezado al paginar,
 * bloques de totales por modalidad, desglose de IVA, importe con letra y
 * leyenda obligatoria "Cotización — no es comprobante fiscal".
 */
export function renderQuotationPdf(data: QuotationPdfData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const margin = 45;
        const doc = new PDFDocument({
            size: 'LETTER',
            margin,
            compress: false,
        });

        const chunks: Buffer[] = [];
        doc.on('data', (chunk) => chunks.push(chunk as Buffer));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const primaryColor = sanitizeHexColor(data.primaryColor);
        const pageWidth = 612; // LETTER width in points
        const pageHeight = 792; // LETTER height in points
        const contentWidth = pageWidth - margin * 2;
        const tz = data.timezone || 'America/Mexico_City';
        const currency = (data.currency || 'MXN').toUpperCase();

        // 1. Encabezado principal
        doc.rect(margin, margin, contentWidth, 6).fill(primaryColor);
        let y = margin + 16;

        doc.fillColor('#111827').font('Helvetica-Bold').fontSize(16).text(data.organizationName, margin, y, {
            width: contentWidth * 0.58,
        });

        // Bloque derecho: Folio y fechas
        const rightBoxX = margin + contentWidth * 0.6;
        const rightBoxWidth = contentWidth * 0.4;
        doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(13).text('COTIZACIÓN', rightBoxX, y, {
            width: rightBoxWidth,
            align: 'right',
        });
        doc.fillColor('#111827').font('Helvetica-Bold').fontSize(11).text(`Folio: ${data.folio}`, rightBoxX, y + 16, {
            width: rightBoxWidth,
            align: 'right',
        });
        if (typeof data.revisionNumber === 'number' && data.revisionNumber > 0) {
            doc.font('Helvetica').fontSize(9).fillColor('#4b5563').text(`Revisión #${data.revisionNumber}`, rightBoxX, y + 30, {
                width: rightBoxWidth,
                align: 'right',
            });
        }

        // Datos de la organización (izquierda)
        let leftY = doc.y + 4;
        doc.font('Helvetica').fontSize(9).fillColor('#374151');
        if (data.organizationLegalName && data.organizationLegalName !== data.organizationName) {
            doc.text(data.organizationLegalName, margin, leftY, { width: contentWidth * 0.58 });
            leftY = doc.y;
        }
        if (data.organizationTaxId) {
            doc.text(`RFC: ${data.organizationTaxId}`, margin, leftY, { width: contentWidth * 0.58 });
            leftY = doc.y;
        }
        if (data.organizationAddress) {
            doc.text(data.organizationAddress, margin, leftY, { width: contentWidth * 0.58 });
            leftY = doc.y;
        }
        const contactParts = [data.organizationPhone, data.organizationEmail].filter(Boolean);
        if (contactParts.length > 0) {
            doc.text(contactParts.join(' · '), margin, leftY, { width: contentWidth * 0.58 });
            leftY = doc.y;
        }

        // Fechas a la derecha
        const rightMetaY = y + (typeof data.revisionNumber === 'number' && data.revisionNumber > 0 ? 44 : 32);
        doc.font('Helvetica').fontSize(9).fillColor('#374151');
        doc.text(`Emisión: ${formatDateInTimezone(data.emittedAt, tz)}`, rightBoxX, rightMetaY, {
            width: rightBoxWidth,
            align: 'right',
        });
        doc.text(`Vigencia: ${formatDateInTimezone(data.validUntil, tz)}`, rightBoxX, rightMetaY + 13, {
            width: rightBoxWidth,
            align: 'right',
        });
        doc.text(`Moneda: ${currency}`, rightBoxX, rightMetaY + 26, {
            width: rightBoxWidth,
            align: 'right',
        });

        y = Math.max(leftY, rightMetaY + 42) + 10;

        if (data.headerNote) {
            doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#4b5563').text(data.headerNote, margin, y, {
                width: contentWidth,
            });
            y = doc.y + 8;
        }

        // 2. Bloque de Cliente
        doc.rect(margin, y, contentWidth, 52).fillAndStroke('#f9fafb', '#e5e7eb');
        doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(9.5).text('CLIENTE / DESTINATARIO', margin + 10, y + 7);
        doc.fillColor('#111827').font('Helvetica-Bold').fontSize(9.5).text(
            data.customerName || 'Cliente General',
            margin + 10,
            y + 21,
            { width: contentWidth * 0.5 - 15 }
        );
        if (data.customerCompany) {
            doc.font('Helvetica').fontSize(8.5).fillColor('#374151').text(
                `Empresa: ${data.customerCompany}`,
                margin + 10,
                y + 34,
                { width: contentWidth * 0.5 - 15 }
            );
        }

        const custRightX = margin + contentWidth * 0.52;
        doc.font('Helvetica').fontSize(8.5).fillColor('#374151');
        if (data.customerEmail) {
            doc.text(`Correo: ${data.customerEmail}`, custRightX, y + 21, { width: contentWidth * 0.45 });
        }
        if (data.customerPhone) {
            doc.text(`Teléfono: ${data.customerPhone}`, custRightX, y + 34, { width: contentWidth * 0.45 });
        }

        y += 64;

        // 3. Tabla de partidas con encabezado repetible al paginar
        const colX = {
            num: margin,
            sku: margin + 22,
            desc: margin + 112,
            mod: margin + 278,
            qty: margin + 332,
            unit: margin + 378,
            amount: margin + 450,
        };
        const colW = {
            num: 20,
            sku: 86,
            desc: 162,
            mod: 50,
            qty: 42,
            unit: 68,
            amount: 72,
        };

        const drawTableHeader = (topY: number): number => {
            doc.rect(margin, topY, contentWidth, 20).fill(primaryColor);
            doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);
            doc.text('#', colX.num + 2, topY + 6, { width: colW.num });
            doc.text('SKU', colX.sku, topY + 6, { width: colW.sku });
            doc.text('Descripción', colX.desc, topY + 6, { width: colW.desc });
            doc.text('Modalidad', colX.mod, topY + 6, { width: colW.mod });
            doc.text('Cant.', colX.qty, topY + 6, { width: colW.qty, align: 'right' });
            doc.text('P. Unit.', colX.unit, topY + 6, { width: colW.unit, align: 'right' });
            doc.text('Importe', colX.amount, topY + 6, { width: colW.amount, align: 'right' });
            return topY + 24;
        };

        const ensureSpace = (neededHeight: number, repeatTableHeader = false): void => {
            if (y + neededHeight > pageHeight - 65) {
                doc.addPage({ size: 'LETTER', margin });
                doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text(
                    `${data.organizationName} — Cotización ${data.folio}`,
                    margin,
                    margin - 15,
                    { width: contentWidth, align: 'right' }
                );
                y = margin + 4;
                if (repeatTableHeader) {
                    y = drawTableHeader(y);
                }
            }
        };

        y = drawTableHeader(y);

        for (let idx = 0; idx < data.items.length; idx++) {
            const item = data.items[idx];
            const titleLine = item.variantName && item.variantName !== item.productName
                ? `${item.productName} - ${item.variantName}`
                : item.productName;
            const fullDesc = item.description ? `${titleLine}\n${item.description}` : titleLine;

            doc.font('Helvetica').fontSize(8.5);
            const descHeight = doc.heightOfString(fullDesc, { width: colW.desc });
            const rowHeight = Math.max(18, descHeight + 6);

            ensureSpace(rowHeight + 4, true);

            if (idx % 2 === 1) {
                doc.rect(margin, y - 2, contentWidth, rowHeight).fill('#f9fafb');
            }

            doc.fillColor('#111827').font('Helvetica').fontSize(8.5);
            doc.text(String(item.lineNumber ?? idx + 1), colX.num + 2, y, { width: colW.num });
            doc.font('Helvetica-Bold').text(item.sku, colX.sku, y, { width: colW.sku });
            doc.font('Helvetica').text(fullDesc, colX.desc, y, { width: colW.desc });
            doc.text(formatBillingPeriodLabel(item.billingPeriod), colX.mod, y, { width: colW.mod });
            doc.text(`${item.quantity} ${item.unitOfMeasure || ''}`.trim(), colX.qty, y, {
                width: colW.qty,
                align: 'right',
            });
            doc.text(formatMoney(item.unitPrice, currency), colX.unit, y, {
                width: colW.unit,
                align: 'right',
            });
            doc.font('Helvetica-Bold').text(formatMoney(item.lineSubtotal, currency), colX.amount, y, {
                width: colW.amount,
                align: 'right',
            });

            y += rowHeight;
        }

        doc.moveTo(margin, y + 2).lineTo(margin + contentWidth, y + 2).strokeColor('#d1d5db').stroke();
        y += 12;

        // 4. Bloques de totales por modalidad + Totales globales + Importe con letra
        ensureSpace(140, false);

        const billingEntries = Object.entries(data.totalsByBilling ?? {}).filter(
            (entry): entry is [BillingPeriod, QuotationPdfBillingBlock] => Boolean(entry[1] && entry[1].total > 0)
        );

        if (billingEntries.length > 0) {
            doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(9.5).text(
                'RESUMEN POR MODALIDAD DE FACTURACIÓN',
                margin,
                y
            );
            y = doc.y + 4;

            for (const [period, block] of billingEntries) {
                const label =
                    period === 'unico'
                        ? 'Pago Único'
                        : period === 'mensual'
                          ? 'Recurrente Mensual'
                          : 'Recurrente Anual';
                doc.fillColor('#374151').font('Helvetica').fontSize(8.5).text(
                    `• ${label}: Subtotal ${formatMoney(block.subtotal, currency)} + IVA ${formatMoney(block.taxTotal, currency)} = Total ${formatMoney(block.total, currency)}`,
                    margin + 6,
                    y,
                    { width: contentWidth }
                );
                y = doc.y + 2;
            }
            y += 6;
        }

        // Desglose general y total inicial a la derecha
        const totalsLabelX = margin + contentWidth * 0.48;
        const totalsValX = margin + contentWidth * 0.75;
        const totalsValW = contentWidth * 0.25;

        const drawTotalLine = (label: string, val: string, bold = false): void => {
            doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9).fillColor('#111827');
            doc.text(label, totalsLabelX, y, { width: contentWidth * 0.26, align: 'right' });
            doc.text(val, totalsValX, y, { width: totalsValW, align: 'right' });
            y += bold ? 15 : 13;
        };

        drawTotalLine('Subtotal:', formatMoney(data.subtotal, currency));
        if (data.discountTotal > 0) {
            drawTotalLine('Descuento:', `-${formatMoney(data.discountTotal, currency)}`);
        }
        if (data.taxBreakdown && data.taxBreakdown.length > 0) {
            for (const taxRow of data.taxBreakdown) {
                drawTotalLine(`IVA (${taxRow.ratePct}%):`, formatMoney(taxRow.tax, currency));
            }
        } else {
            drawTotalLine(`IVA (${data.taxRatePct}%):`, formatMoney(data.taxTotal, currency));
        }
        drawTotalLine('TOTAL INICIAL:', formatMoney(data.total, currency), true);

        // Importe con letra
        const totalCents = Math.round(Number(data.total || 0) * 100);
        const legalWords = amountToLegalSpanish(totalCents, currency);
        y += 4;
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#374151').text(
            `Importe con letra: ${legalWords}`,
            margin,
            y,
            { width: contentWidth }
        );
        y = doc.y + 10;

        // 5. Notas, términos y condiciones
        if (data.notes) {
            ensureSpace(45, false);
            doc.font('Helvetica-Bold').fontSize(9).fillColor('#111827').text('Notas:', margin, y);
            doc.font('Helvetica').fontSize(8.5).fillColor('#374151').text(data.notes, margin, doc.y + 2, {
                width: contentWidth,
            });
            y = doc.y + 8;
        }

        if (data.termsAndConditions) {
            ensureSpace(45, false);
            doc.font('Helvetica-Bold').fontSize(9).fillColor('#111827').text('Términos y condiciones:', margin, y);
            doc.font('Helvetica').fontSize(8.5).fillColor('#374151').text(data.termsAndConditions, margin, doc.y + 2, {
                width: contentWidth,
            });
            y = doc.y + 8;
        }

        if (data.footerNote) {
            ensureSpace(30, false);
            doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#4b5563').text(data.footerNote, margin, y, {
                width: contentWidth,
            });
            y = doc.y + 8;
        }

        // 6. Leyenda fiscal obligatoria
        ensureSpace(25, false);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#6b7280').text(
            'Cotización — no es comprobante fiscal',
            margin,
            y + 4,
            { width: contentWidth, align: 'center' }
        );

        doc.end();
    });
}

export function buildQuotationPdfStoragePath(organizationId: string, folioYear: number, folio: string): string {
    return `${organizationId}/${folioYear}/${folio}.pdf`;
}

export function computePdfSha256(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Extrae el texto legible de un PDF generado por PDFKit decodificando las
 * secuencias hexadecimales WinAnsi de los bloques `BT ... ET`.
 */
export function extractPdfText(buffer: Buffer): string {
    const raw = buffer.toString('latin1');
    const blocks: string[] = [];
    const btEtRegex = /BT\s+([\s\S]*?)\s+ET/g;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = btEtRegex.exec(raw)) !== null) {
        const inner = blockMatch[1];
        const hexRegex = /<([0-9a-fA-F]+)>/g;
        const bytes: number[] = [];
        let hexMatch: RegExpExecArray | null;
        while ((hexMatch = hexRegex.exec(inner)) !== null) {
            const hex = hexMatch[1];
            for (let i = 0; i < hex.length; i += 2) {
                bytes.push(parseInt(hex.slice(i, i + 2), 16));
            }
        }
        if (bytes.length > 0) {
            blocks.push(Buffer.from(bytes).toString('latin1'));
        }
    }
    return blocks.join('\n');
}

export async function ensureQuotationsBucket(fastify: FastifyInstance): Promise<void> {
    try {
        const { data: buckets } = await fastify.supabaseAdmin.storage.listBuckets();
        const exists = buckets?.some((b) => b.name === QUOTATIONS_BUCKET);
        if (!exists) {
            await fastify.supabaseAdmin.storage.createBucket(QUOTATIONS_BUCKET, {
                public: false,
                fileSizeLimit: MAX_QUOTATION_STORAGE_BYTES,
                allowedMimeTypes: ['application/pdf'],
            });
        }
    } catch (err) {
        fastify.log.warn({ err }, '[QuotationPdf] Error al verificar/crear bucket de cotizaciones');
    }
}

export async function uploadQuotationPdf(
    fastify: FastifyInstance,
    params: {
        organizationId: string;
        folioYear: number;
        folio: string;
        buffer: Buffer;
    }
): Promise<{ storagePath: string; pdfSha256: string; sizeBytes: number }> {
    await ensureQuotationsBucket(fastify);

    const storagePath = buildQuotationPdfStoragePath(params.organizationId, params.folioYear, params.folio);
    const pdfSha256 = computePdfSha256(params.buffer);

    const { error } = await fastify.supabaseAdmin.storage
        .from(QUOTATIONS_BUCKET)
        .upload(storagePath, params.buffer, {
            contentType: 'application/pdf',
            upsert: true,
        });

    if (error) {
        fastify.log.error(
            { err: error.message, organizationId: params.organizationId, folio: params.folio },
            '[QuotationPdf] Error subiendo PDF a Supabase Storage'
        );
        throw new Error(`No se pudo subir el PDF de la cotización: ${error.message}`);
    }

    return {
        storagePath,
        pdfSha256,
        sizeBytes: params.buffer.length,
    };
}

export async function downloadQuotationPdfBuffer(
    fastify: FastifyInstance,
    storagePath: string
): Promise<Buffer | null> {
    try {
        const { data, error } = await fastify.supabaseAdmin.storage
            .from(QUOTATIONS_BUCKET)
            .download(storagePath);

        if (error || !data) {
            fastify.log.warn({ err: error?.message, storagePath }, '[QuotationPdf] Error descargando PDF de Storage');
            return null;
        }
        const ab = await data.arrayBuffer();
        return Buffer.from(ab);
    } catch (err) {
        fastify.log.error({ err, storagePath }, '[QuotationPdf] Excepción descargando PDF de Storage');
        return null;
    }
}

export async function createQuotationPdfSignedUrl(
    fastify: FastifyInstance,
    storagePath: string,
    expiresInSeconds = 3600 * 24
): Promise<string | null> {
    try {
        const { data, error } = await fastify.supabaseAdmin.storage
            .from(QUOTATIONS_BUCKET)
            .createSignedUrl(storagePath, expiresInSeconds);

        if (error || !data?.signedUrl) {
            fastify.log.warn({ err: error?.message, storagePath }, '[QuotationPdf] Error creando signedUrl de PDF');
            return null;
        }
        return data.signedUrl;
    } catch (err) {
        fastify.log.error({ err, storagePath }, '[QuotationPdf] Excepción creando signedUrl de PDF');
        return null;
    }
}
