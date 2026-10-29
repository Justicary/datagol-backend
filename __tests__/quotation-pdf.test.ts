import { describe, it, expect } from 'vitest';
import { validateAttachmentMagicBytes } from '../src/lib/magic-bytes.js';
import {
    renderQuotationPdf,
    buildQuotationPdfStoragePath,
    computePdfSha256,
    extractPdfText,
    type QuotationPdfData,
} from '../src/services/quotations/quotation-pdf.js';

describe('Fase E — Generación de PDF de cotización (quotation-pdf)', () => {
    const sampleData: QuotationPdfData = {
        organizationName: 'Acero y Soluciones S.A. de C.V.',
        organizationTaxId: 'ASO210101AAA',
        organizationAddress: 'Av. Reforma 100, CDMX',
        organizationPhone: '+525512345678',
        organizationEmail: 'ventas@acero.mx',
        primaryColor: '#1e3a8a',
        headerNote: 'Precios sujetos a disponibilidad.',
        folio: 'COT-2026-000042-R1',
        revisionNumber: 1,
        emittedAt: '2026-10-26T18:30:00.000Z',
        validUntil: '2026-11-10',
        timezone: 'America/Mexico_City',
        currency: 'MXN',
        taxRatePct: 16,
        customerName: 'Roberto Gómez',
        customerCompany: 'Constructora del Valle',
        customerEmail: 'roberto@delvalle.mx',
        customerPhone: '+525598765432',
        items: [
            {
                lineNumber: 1,
                sku: 'PLAN-PRO-SETUP',
                productName: 'Plan Profesional',
                variantName: 'Implementación Inicial',
                itemType: 'plan',
                billingPeriod: 'unico',
                unitOfMeasure: 'servicio',
                quantity: 1,
                unitPrice: 49000,
                discountAmount: 0,
                lineSubtotal: 49000,
                lineTax: 7840,
                lineTotal: 56840,
            },
            {
                lineNumber: 2,
                sku: 'PLAN-PRO-MAINT',
                productName: 'Plan Profesional',
                variantName: 'Mantenimiento Mensual',
                itemType: 'servicio',
                billingPeriod: 'mensual',
                unitOfMeasure: 'mes',
                quantity: 1,
                unitPrice: 3999,
                discountAmount: 0,
                lineSubtotal: 3999,
                lineTax: 639.84,
                lineTotal: 4638.84,
            },
            {
                lineNumber: 3,
                sku: 'LIC-ANUAL-01',
                productName: 'Licencia Enterprise',
                variantName: 'Suscripción Anual',
                itemType: 'servicio',
                billingPeriod: 'anual',
                unitOfMeasure: 'año',
                quantity: 1,
                unitPrice: 12000,
                discountAmount: 0,
                lineSubtotal: 12000,
                lineTax: 1920,
                lineTotal: 13920,
            },
        ],
        subtotal: 64999,
        discountTotal: 0,
        taxTotal: 10399.84,
        total: 75398.84,
        totalsByBilling: {
            unico: { subtotal: 49000, discountTotal: 0, taxTotal: 7840, total: 56840 },
            mensual: { subtotal: 3999, discountTotal: 0, taxTotal: 639.84, total: 4638.84 },
            anual: { subtotal: 12000, discountTotal: 0, taxTotal: 1920, total: 13920 },
        },
        taxBreakdown: [
            { ratePct: 16, base: 64999, tax: 10399.84 },
        ],
        notes: 'Entrega estimada en 5 días hábiles.',
        termsAndConditions: '50% anticipo y 50% contra entrega.',
        footerNote: 'Gracias por su preferencia.',
    };

    it('genera un buffer PDF válido según validateAttachmentMagicBytes (%PDF) con folio, bloques por modalidad, importe con letra y leyenda no fiscal', async () => {
        const buffer = await renderQuotationPdf(sampleData);

        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(500);
        // Tope de 7 MB para adjunto por correo
        expect(buffer.length).toBeLessThan(7 * 1024 * 1024);

        const magic = validateAttachmentMagicBytes(buffer);
        expect(magic).not.toBeNull();
        expect(magic?.mimeType).toBe('application/pdf');
        expect(magic?.extension).toBe('pdf');

        const extractedText = extractPdfText(buffer);
        // Folio y revisión
        expect(extractedText).toContain('COT-2026-000042-R1');
        // Modalidades en la tabla y en bloques de totales
        expect(extractedText).toContain('PLAN-PRO-SETUP');
        expect(extractedText).toContain('PLAN-PRO-MAINT');
        expect(extractedText).toContain('LIC-ANUAL-01');
        expect(extractedText).toContain('Mensual');
        expect(extractedText).toContain('Anual');
        expect(extractedText).toContain('Pago Único');
        expect(extractedText).toContain('Recurrente Mensual');
        expect(extractedText).toContain('Recurrente Anual');
        // Importe con letra del total inicial (75,398.84 -> SETENTA Y CINCO MIL TRESCIENTOS NOVENTA Y OCHO PESOS 84/100 M.N.)
        expect(extractedText).toContain('SETENTA Y CINCO MIL TRESCIENTOS NOVENTA Y OCHO PESOS 84/100 M.N.');
        // Leyenda obligatoria
        expect(extractedText).toContain('no es comprobante fiscal');
    });

    it('pagina correctamente cuando la cotización tiene 40 partidas y repite el encabezado de tabla en páginas adicionales', async () => {
        const manyItems: QuotationPdfData['items'] = Array.from({ length: 40 }, (_, idx) => ({
            lineNumber: idx + 1,
            sku: `SKU-ITEM-${String(idx + 1).padStart(3, '0')}`,
            productName: `Producto Industrial de Prueba Número ${idx + 1} con Descripción Extendida`,
            variantName: `Modelo Estándar Lote ${idx + 1}`,
            itemType: 'producto' as const,
            billingPeriod: 'unico' as const,
            unitOfMeasure: 'pieza',
            quantity: 2,
            unitPrice: 1000,
            discountAmount: 0,
            lineSubtotal: 2000,
            lineTax: 320,
            lineTotal: 2320,
        }));

        const buffer = await renderQuotationPdf({
            ...sampleData,
            folio: 'COT-2026-000099',
            revisionNumber: 0,
            items: manyItems,
            subtotal: 80000,
            discountTotal: 0,
            taxTotal: 12800,
            total: 92800,
            totalsByBilling: {
                unico: { subtotal: 80000, discountTotal: 0, taxTotal: 12800, total: 92800 },
            },
        });

        expect(validateAttachmentMagicBytes(buffer)?.extension).toBe('pdf');
        const rawText = buffer.toString('latin1');
        const extractedText = extractPdfText(buffer);
        // Verificar primera y última partida presentes
        expect(extractedText).toContain('SKU-ITEM-001');
        expect(extractedText).toContain('SKU-ITEM-040');
        // Verificar múltiples páginas en el árbol de páginas de PDFKit (/Type /Page)
        const pageMatches = rawText.match(/\/Type\s*\/Page\b/g) ?? [];
        expect(pageMatches.length).toBeGreaterThanOrEqual(2);
        // Encabezado de tabla repetido en cada página con partidas
        const headerOccurrences = extractedText.split('Modalidad').length - 1;
        expect(headerOccurrences).toBeGreaterThanOrEqual(2);
    });

    it('construye la ruta de Storage canónica y calcula el hash SHA-256 del PDF', async () => {
        const path = buildQuotationPdfStoragePath('11111111-2222-3333-4444-555555555555', 2026, 'COT-2026-000001');
        expect(path).toBe('11111111-2222-3333-4444-555555555555/2026/COT-2026-000001.pdf');

        const sha = computePdfSha256(Buffer.from('%PDF-test', 'utf-8'));
        expect(sha).toMatch(/^[a-f0-9]{64}$/);
    });
});
