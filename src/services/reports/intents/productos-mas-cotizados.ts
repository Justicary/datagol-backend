import { z } from 'zod';
import { FastifyInstance } from 'fastify';
import {
    NL_INTENT_KEYS,
    NL_INTENT_CATEGORIES,
    NL_RESULT_SHAPES,
    type NlIntentDefinition,
    type ResolvedPeriod,
    type IntentExecutionResult,
} from '../../../types/natural-reports.js';

export const productosMasCotizadosSchema = z.object({
    limit: z.number().int().min(1).max(20).optional(),
});
export type ProductosMasCotizadosParams = z.infer<typeof productosMasCotizadosSchema>;

export interface ProductoMasCotizadoRow {
    sku: string;
    productName: string;
    itemType: string;
    quoteCount: number;
    totalQuantity: number;
    totalAmount: number;
}

export interface ProductosMasCotizadosData {
    items: ProductoMasCotizadoRow[];
    periodoEtiqueta: string;
}

export const productosMasCotizadosIntent: NlIntentDefinition<
    ProductosMasCotizadosParams,
    ProductosMasCotizadosData
> = {
    key: NL_INTENT_KEYS.PRODUCTOS_MAS_COTIZADOS,
    category: NL_INTENT_CATEGORIES.COTIZACIONES,
    description:
        'Ranking de los productos, servicios o planes más cotizados en el periodo por frecuencia y monto cotizado.',
    examples: [
        '¿Cuáles son los productos más cotizados este mes?',
        '¿Qué planes o servicios nos piden cotizar más?',
        'Top de productos en cotizaciones de la semana',
        'Artículos más cotizados por los clientes',
    ],
    resultShape: NL_RESULT_SHAPES.TABLA,
    parametersSchema: productosMasCotizadosSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        params: ProductosMasCotizadosParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<ProductosMasCotizadosData>> => {
        const { data: rows, error } = await fastify.supabaseAdmin
            .from('quotation_items')
            .select('sku, product_name, item_type, quantity, line_total')
            .eq('organization_id', organizationId)
            .gte('created_at', period.startUtc)
            .lte('created_at', period.endUtc);

        if (error) {
            fastify.log.error(
                { err: error.message, organizationId },
                '[NlIntent:productos_mas_cotizados] Error consultando partidas cotizadas'
            );
            throw new Error(`Error al consultar productos más cotizados: ${error.message}`);
        }

        const bySku = new Map<string, ProductoMasCotizadoRow>();
        for (const r of rows ?? []) {
            const sku = String(r.sku ?? '');
            const existing = bySku.get(sku) ?? {
                sku,
                productName: String(r.product_name ?? sku),
                itemType: String(r.item_type ?? 'producto'),
                quoteCount: 0,
                totalQuantity: 0,
                totalAmount: 0,
            };
            existing.quoteCount += 1;
            existing.totalQuantity += Number(r.quantity ?? 0);
            existing.totalAmount = Math.round((existing.totalAmount + Number(r.line_total ?? 0)) * 100) / 100;
            bySku.set(sku, existing);
        }

        const topLimit = params.limit ?? 10;
        const items = Array.from(bySku.values())
            .sort((a, b) => b.quoteCount - a.quoteCount || b.totalAmount - a.totalAmount)
            .slice(0, topLimit);

        const warnings: string[] = [];
        if (items.length === 0) {
            warnings.push('No se registraron partidas cotizadas en el periodo seleccionado.');
        }

        return {
            shape: NL_RESULT_SHAPES.TABLA,
            data: {
                items,
                periodoEtiqueta: period.label,
            },
            warnings,
            summaryMetrics: {
                distinctProductsQuoted: bySku.size,
                topProductSku: items[0]?.sku ?? null,
            },
        };
    },
};
