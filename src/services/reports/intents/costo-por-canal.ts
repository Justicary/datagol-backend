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

export const costoPorCanalSchema = z.object({});
export type CostoPorCanalParams = z.infer<typeof costoPorCanalSchema>;

export interface CostoPorCanalRow {
    proveedor: string;
    costoUsd: number;
    porcentaje: number;
    totalEventos: number;
}

export interface CostoPorCanalData {
    filas: CostoPorCanalRow[];
    costoTotalUsd: number;
}

export const costoPorCanalIntent: NlIntentDefinition<CostoPorCanalParams, CostoPorCanalData> = {
    key: NL_INTENT_KEYS.COSTO_POR_CANAL,
    category: NL_INTENT_CATEGORIES.COSTO,
    description: 'Desglose del gasto de consumo agrupado por canal o proveedor de servicio (voz, telefonía, IA, WhatsApp).',
    examples: [
        '¿Cuánto gasté en llamadas vs WhatsApp?',
        'Desglose de costo por canal de este mes',
        'Costo por proveedor de la semana pasada',
        '¿En qué servicio se gasta más?',
    ],
    resultShape: NL_RESULT_SHAPES.TABLA,
    parametersSchema: costoPorCanalSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: CostoPorCanalParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<CostoPorCanalData>> => {
        const { data, error } = await fastify.supabaseAdmin
            .from('usage_events')
            .select('provider, amount_usd, quantity')
            .eq('organization_id', organizationId)
            .gte('occurred_at', period.startUtc)
            .lte('occurred_at', period.endUtc);

        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:costo_por_canal] Error calculando costo por canal');
            throw new Error(`Error al calcular costo por canal: ${error.message}`);
        }

        const providerTotals = new Map<string, { amount: number; events: number }>();
        let costoTotalUsd = 0;

        for (const row of data ?? []) {
            const prov = row.provider || 'otro';
            const amt = Number(row.amount_usd ?? 0);
            costoTotalUsd += amt;

            const existing = providerTotals.get(prov) ?? { amount: 0, events: 0 };
            existing.amount += amt;
            existing.events += 1;
            providerTotals.set(prov, existing);
        }

        costoTotalUsd = Math.round(costoTotalUsd * 100) / 100;

        const filas: CostoPorCanalRow[] = Array.from(providerTotals.entries()).map(([proveedor, val]) => {
            const costRound = Math.round(val.amount * 100) / 100;
            const pct = costoTotalUsd > 0 ? Math.round((costRound / costoTotalUsd) * 1000) / 10 : 0;
            return {
                proveedor,
                costoUsd: costRound,
                porcentaje: pct,
                totalEventos: val.events,
            };
        }).sort((a, b) => b.costoUsd - a.costoUsd);

        const warnings: string[] = [];

        return {
            shape: NL_RESULT_SHAPES.TABLA,
            data: {
                filas,
                costoTotalUsd,
            },
            warnings,
            summaryMetrics: { costoTotalUsd },
        };
    },
};
