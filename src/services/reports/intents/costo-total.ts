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

export const costoTotalSchema = z.object({});
export type CostoTotalParams = z.infer<typeof costoTotalSchema>;

export interface CostoTotalData {
    costoTotalUsd: number;
    totalEventos: number;
    periodoEtiqueta: string;
}

export const costoTotalIntent: NlIntentDefinition<CostoTotalParams, CostoTotalData> = {
    key: NL_INTENT_KEYS.COSTO_TOTAL,
    category: NL_INTENT_CATEGORIES.COSTO,
    description: 'Gasto total acumulado en USD por el uso de servicios (voz, IA, telefonía, mensajería) en el periodo.',
    examples: [
        '¿Cuánto he gastado este mes?',
        'Costo total de la semana pasada',
        '¿Cuál es el gasto acumulado de hoy?',
        'Total consumido en dólares en el periodo',
    ],
    resultShape: NL_RESULT_SHAPES.NUMERO,
    parametersSchema: costoTotalSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: CostoTotalParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<CostoTotalData>> => {
        // Trampa de esquema: usage_events es append-only con asientos compensatorios negativos.
        // Se suma TODO sin filtrar amount_usd > 0 ni quantity > 0.
        const { data, error } = await fastify.supabaseAdmin
            .from('usage_events')
            .select('amount_usd')
            .eq('organization_id', organizationId)
            .gte('occurred_at', period.startUtc)
            .lte('occurred_at', period.endUtc);

        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:costo_total] Error calculando costo total');
            throw new Error(`Error al calcular costo total: ${error.message}`);
        }

        let costoTotalUsd = 0;
        let totalEventos = 0;

        for (const row of data ?? []) {
            costoTotalUsd += Number(row.amount_usd ?? 0);
            totalEventos++;
        }

        costoTotalUsd = Math.round(costoTotalUsd * 100) / 100;
        const warnings: string[] = [];

        return {
            shape: NL_RESULT_SHAPES.NUMERO,
            data: {
                costoTotalUsd,
                totalEventos,
                periodoEtiqueta: period.label,
            },
            warnings,
            summaryMetrics: { costoTotalUsd, totalEventos },
        };
    },
};
