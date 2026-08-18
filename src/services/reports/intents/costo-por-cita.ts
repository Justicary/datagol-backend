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

export const costoPorCitaSchema = z.object({});
export type CostoPorCitaParams = z.infer<typeof costoPorCitaSchema>;

export interface CostoPorCitaData {
    costoPorCitaUsd: number;
    costoTotalUsd: number;
    totalCitas: number;
    periodoEtiqueta: string;
}

export const costoPorCitaIntent: NlIntentDefinition<CostoPorCitaParams, CostoPorCitaData> = {
    key: NL_INTENT_KEYS.COSTO_POR_CITA,
    category: NL_INTENT_CATEGORIES.COSTO,
    description: 'Costo promedio por cita agendada (gasto total de la plataforma dividido entre el número de citas agendadas).',
    examples: [
        '¿Cuánto me cuesta cada cita agendada?',
        'Costo por cita de este mes',
        'Costo por cita agendada de la semana pasada',
        '¿Cuál es el costo por agendamiento?',
    ],
    resultShape: NL_RESULT_SHAPES.NUMERO,
    parametersSchema: costoPorCitaSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: CostoPorCitaParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<CostoPorCitaData>> => {
        // 1. Costo total de usage_events
        const { data: usageData, error: usageErr } = await fastify.supabaseAdmin
            .from('usage_events')
            .select('amount_usd')
            .eq('organization_id', organizationId)
            .gte('occurred_at', period.startUtc)
            .lte('occurred_at', period.endUtc);

        if (usageErr) {
            fastify.log.error({ err: usageErr.message, organizationId }, '[NlIntent:costo_por_cita] Error consultando uso');
            throw new Error(`Error al consultar costo de uso: ${usageErr.message}`);
        }

        let costoTotalUsd = 0;
        for (const row of usageData ?? []) {
            costoTotalUsd += Number(row.amount_usd ?? 0);
        }
        costoTotalUsd = Math.round(costoTotalUsd * 100) / 100;

        // 2. Conteo de citas
        const { count: citasCount, error: citasErr } = await fastify.supabaseAdmin
            .from('appointments')
            .select('*', { count: 'exact', head: true })
            .eq('organization_id', organizationId)
            .gte('start_time', period.startUtc)
            .lte('start_time', period.endUtc);

        if (citasErr) {
            fastify.log.error({ err: citasErr.message, organizationId }, '[NlIntent:costo_por_cita] Error contando citas');
            throw new Error(`Error al contar citas: ${citasErr.message}`);
        }

        const totalCitas = citasCount ?? 0;
        const costoPorCitaUsd = totalCitas > 0 ? Math.round((costoTotalUsd / totalCitas) * 100) / 100 : 0;

        const warnings: string[] = [
            `Calculado sobre un gasto total de $${costoTotalUsd} USD y un denominador de ${totalCitas} citas agendadas.`,
        ];

        if (totalCitas < 20) {
            warnings.push(`Muestra pequeña: el cálculo se basa en ${totalCitas} citas.`);
        }

        return {
            shape: NL_RESULT_SHAPES.NUMERO,
            data: {
                costoPorCitaUsd,
                costoTotalUsd,
                totalCitas,
                periodoEtiqueta: period.label,
            },
            warnings,
            summaryMetrics: {
                costoPorCitaUsd,
                costoTotalUsd,
                totalCitas,
            },
        };
    },
};
