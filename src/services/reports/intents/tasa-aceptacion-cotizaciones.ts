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

export const tasaAceptacionCotizacionesSchema = z.object({});
export type TasaAceptacionCotizacionesParams = z.infer<typeof tasaAceptacionCotizacionesSchema>;

export interface TasaAceptacionCotizacionesData {
    carritosCreados: number;
    cotizacionesEmitidas: number;
    cotizacionesAceptadas: number;
    cotizacionesRechazadas: number;
    cotizacionesAbandonadas: number;
    tasaCarritoAEmitidaPct: number;
    tasaEmitidaAAceptadaPct: number;
    ticketPromedioEmitidas: number;
    periodoEtiqueta: string;
}

export const tasaAceptacionCotizacionesIntent: NlIntentDefinition<
    TasaAceptacionCotizacionesParams,
    TasaAceptacionCotizacionesData
> = {
    key: NL_INTENT_KEYS.TASA_ACEPTACION_COTIZACIONES,
    category: NL_INTENT_CATEGORIES.COTIZACIONES,
    description:
        'Tasa de conversión y aceptación de cotizaciones: porcentaje de carritos que se emiten, porcentaje de cotizaciones emitidas que se aceptan y ticket promedio.',
    examples: [
        '¿Cuál es la tasa de aceptación de mis cotizaciones?',
        '¿Qué porcentaje de cotizaciones emitidas nos aprueban?',
        'Conversión de cotizaciones este mes',
        '¿Cuál es el ticket promedio de las cotizaciones emitidas?',
    ],
    resultShape: NL_RESULT_SHAPES.TABLA,
    parametersSchema: tasaAceptacionCotizacionesSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: TasaAceptacionCotizacionesParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<TasaAceptacionCotizacionesData>> => {
        const { data: rows, error } = await fastify.supabaseAdmin
            .from('quotations')
            .select('status, total')
            .eq('organization_id', organizationId)
            .gte('created_at', period.startUtc)
            .lte('created_at', period.endUtc);

        if (error) {
            fastify.log.error(
                { err: error.message, organizationId },
                '[NlIntent:tasa_aceptacion_cotizaciones] Error consultando cotizaciones'
            );
            throw new Error(`Error al consultar cotizaciones: ${error.message}`);
        }

        const list = rows ?? [];
        const carritosCreados = list.length;
        const emittedStatuses = new Set(['emitida', 'enviada', 'aceptada', 'rechazada', 'vencida', 'convertida']);
        const emitted = list.filter((r) => emittedStatuses.has(String(r.status)));
        const accepted = list.filter((r) => r.status === 'aceptada' || r.status === 'convertida');
        const rejected = list.filter((r) => r.status === 'rechazada');
        const abandoned = list.filter((r) => r.status === 'abandonada');

        const cotizacionesEmitidas = emitted.length;
        const cotizacionesAceptadas = accepted.length;
        const cotizacionesRechazadas = rejected.length;
        const cotizacionesAbandonadas = abandoned.length;

        const tasaCarritoAEmitidaPct =
            carritosCreados > 0 ? Math.round((cotizacionesEmitidas / carritosCreados) * 1000) / 10 : 0;
        const tasaEmitidaAAceptadaPct =
            cotizacionesEmitidas > 0 ? Math.round((cotizacionesAceptadas / cotizacionesEmitidas) * 1000) / 10 : 0;

        const sumTotal = emitted.reduce((acc, r) => acc + Number(r.total ?? 0), 0);
        const ticketPromedioEmitidas =
            cotizacionesEmitidas > 0 ? Math.round((sumTotal / cotizacionesEmitidas) * 100) / 100 : 0;

        const warnings: string[] = [
            `Tasa de aceptación: ${tasaEmitidaAAceptadaPct}% (${cotizacionesAceptadas} aceptadas de ${cotizacionesEmitidas} emitidas).`,
        ];
        if (cotizacionesEmitidas < 10) {
            warnings.push('Muestra pequeña: menos de 10 cotizaciones emitidas en el periodo.');
        }

        return {
            shape: NL_RESULT_SHAPES.TABLA,
            data: {
                carritosCreados,
                cotizacionesEmitidas,
                cotizacionesAceptadas,
                cotizacionesRechazadas,
                cotizacionesAbandonadas,
                tasaCarritoAEmitidaPct,
                tasaEmitidaAAceptadaPct,
                ticketPromedioEmitidas,
                periodoEtiqueta: period.label,
            },
            warnings,
            summaryMetrics: {
                tasaEmitidaAAceptadaPct,
                tasaCarritoAEmitidaPct,
                cotizacionesEmitidas,
                cotizacionesAceptadas,
                ticketPromedioEmitidas,
            },
        };
    },
};
