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

export const conteoCotizacionesSchema = z.object({
    status: z.string().optional(),
});

export type ConteoCotizacionesParams = z.infer<typeof conteoCotizacionesSchema>;

export interface ConteoCotizacionesData {
    total: number;
    filtroEstado?: string;
    periodoEtiqueta: string;
}

export const conteoCotizacionesIntent: NlIntentDefinition<ConteoCotizacionesParams, ConteoCotizacionesData> = {
    key: NL_INTENT_KEYS.CONTEO_COTIZACIONES,
    category: NL_INTENT_CATEGORIES.COTIZACIONES,
    description: 'Conteo numérico del total de cotizaciones creadas o emitidas en el periodo seleccionado.',
    examples: [
        '¿Cuántas cotizaciones se emitieron este mes?',
        '¿Cuántas cotizaciones generamos esta semana?',
        'Total de cotizaciones aceptadas en el mes',
        '¿Cuántas cotizaciones tenemos hoy?',
    ],
    resultShape: NL_RESULT_SHAPES.NUMERO,
    parametersSchema: conteoCotizacionesSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        params: ConteoCotizacionesParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<ConteoCotizacionesData>> => {
        let query = fastify.supabaseAdmin
            .from('quotations')
            .select('*', { count: 'exact', head: true })
            .eq('organization_id', organizationId)
            .gte('created_at', period.startUtc)
            .lte('created_at', period.endUtc);

        if (params.status && params.status.trim() !== '') {
            query = query.eq('status', params.status.trim().toLowerCase());
        }

        const { count, error } = await query;
        if (error) {
            fastify.log.error(
                { err: error.message, organizationId },
                '[NlIntent:conteo_cotizaciones] Error contando cotizaciones'
            );
            throw new Error(`Error al contar cotizaciones: ${error.message}`);
        }

        const total = count ?? 0;
        const warnings: string[] = [];
        if (total < 10) {
            warnings.push(`Muestra pequeña: se registraron ${total} cotizaciones en el periodo.`);
        }

        return {
            shape: NL_RESULT_SHAPES.NUMERO,
            data: {
                total,
                filtroEstado: params.status,
                periodoEtiqueta: period.label,
            },
            warnings,
            summaryMetrics: { total },
        };
    },
};
