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

export const costoPorProspectoSchema = z.object({});
export type CostoPorProspectoParams = z.infer<typeof costoPorProspectoSchema>;

export interface CostoPorProspectoData {
    costoPorProspectoUsd: number;
    costoTotalUsd: number;
    totalProspectosNuevos: number;
    periodoEtiqueta: string;
}

export const costoPorProspectoIntent: NlIntentDefinition<
    CostoPorProspectoParams,
    CostoPorProspectoData
> = {
    key: NL_INTENT_KEYS.COSTO_POR_PROSPECTO,
    category: NL_INTENT_CATEGORIES.COSTO,
    description: 'Costo promedio de adquisición por prospecto (gasto total de la plataforma dividido entre los nuevos prospectos captados).',
    examples: [
        '¿Cuánto me cuesta cada prospecto?',
        'Costo por lead este mes',
        '¿Cuál fue el costo por prospecto la semana pasada?',
        'CAC estimado del mes',
    ],
    resultShape: NL_RESULT_SHAPES.NUMERO,
    parametersSchema: costoPorProspectoSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: CostoPorProspectoParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<CostoPorProspectoData>> => {
        // 1. Costo total de usage_events (sumando todo)
        const { data: usageData, error: usageErr } = await fastify.supabaseAdmin
            .from('usage_events')
            .select('amount_usd')
            .eq('organization_id', organizationId)
            .gte('occurred_at', period.startUtc)
            .lte('occurred_at', period.endUtc);

        if (usageErr) {
            fastify.log.error({ err: usageErr.message, organizationId }, '[NlIntent:costo_por_prospecto] Error consultando uso');
            throw new Error(`Error al consultar costo de uso: ${usageErr.message}`);
        }

        let costoTotalUsd = 0;
        for (const row of usageData ?? []) {
            costoTotalUsd += Number(row.amount_usd ?? 0);
        }
        costoTotalUsd = Math.round(costoTotalUsd * 100) / 100;

        // 2. Conteo de nuevos prospectos (contacts)
        const { count: contactsCount, error: contactsErr } = await fastify.supabaseAdmin
            .from('contacts')
            .select('*', { count: 'exact', head: true })
            .eq('organization_id', organizationId)
            .gte('created_at', period.startUtc)
            .lte('created_at', period.endUtc);

        if (contactsErr) {
            fastify.log.error({ err: contactsErr.message, organizationId }, '[NlIntent:costo_por_prospecto] Error contando contactos');
            throw new Error(`Error al contar prospectos: ${contactsErr.message}`);
        }

        const totalProspectosNuevos = contactsCount ?? 0;
        const costoPorProspectoUsd =
            totalProspectosNuevos > 0 ? Math.round((costoTotalUsd / totalProspectosNuevos) * 100) / 100 : 0;

        const warnings: string[] = [
            `Calculado sobre un gasto total de $${costoTotalUsd} USD y un denominador de ${totalProspectosNuevos} prospectos nuevos.`,
        ];

        if (totalProspectosNuevos < 20) {
            warnings.push(`Muestra pequeña: el cálculo se basa en menos de 20 prospectos (${totalProspectosNuevos}).`);
        }

        return {
            shape: NL_RESULT_SHAPES.NUMERO,
            data: {
                costoPorProspectoUsd,
                costoTotalUsd,
                totalProspectosNuevos,
                periodoEtiqueta: period.label,
            },
            warnings,
            summaryMetrics: {
                costoPorProspectoUsd,
                costoTotalUsd,
                totalProspectosNuevos,
            },
        };
    },
};
