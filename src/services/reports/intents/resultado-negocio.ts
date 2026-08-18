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

export const resultadoNegocioSchema = z.object({});
export type ResultadoNegocioParams = z.infer<typeof resultadoNegocioSchema>;

export interface ResultadoNegocioData {
    clientesCerrados: number;
    cierresConMonto: number;
    valorTotalVendido: number;
    ticketPromedio: number;
    ticketMinimo: number;
    ticketMaximo: number;
    moneda: string;
    periodoEtiqueta: string;
}

export const resultadoNegocioIntent: NlIntentDefinition<
    ResultadoNegocioParams,
    ResultadoNegocioData
> = {
    key: NL_INTENT_KEYS.RESULTADO_NEGOCIO,
    category: NL_INTENT_CATEGORIES.RESULTADO,
    description: 'Métricas de ventas y dinero generado: clientes cerrados (etapa cliente), valor total de cierres y ticket promedio.',
    examples: [
        '¿Cuánto vendí este mes?',
        '¿Cuál fue el resultado del negocio la semana pasada?',
        '¿Cuántos clientes cerraron y qué valor tuvieron?',
        'Total de ventas e ingresos del periodo',
    ],
    resultShape: NL_RESULT_SHAPES.TABLA,
    parametersSchema: resultadoNegocioSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: ResultadoNegocioParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<ResultadoNegocioData>> => {
        const { data, error } = await fastify.supabaseAdmin
            .from('contacts')
            .select('deal_value, deal_currency, won_at')
            .eq('organization_id', organizationId)
            .eq('lifecycle_stage', 'cliente')
            .gte('won_at', period.startUtc)
            .lte('won_at', period.endUtc);

        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:resultado_negocio] Error consultando cierres');
            throw new Error(`Error al consultar resultado de negocio: ${error.message}`);
        }

        const items = data ?? [];
        const clientesCerrados = items.length;
        let cierresConMonto = 0;
        let valorTotal = 0;
        let ticketMin = Number.POSITIVE_INFINITY;
        let ticketMax = 0;
        let moneda = 'MXN';

        for (const item of items) {
            if (item.deal_currency) {
                moneda = item.deal_currency;
            }
            if (item.deal_value !== null && item.deal_value !== undefined) {
                const val = Number(item.deal_value);
                if (!Number.isNaN(val) && val >= 0) {
                    cierresConMonto++;
                    valorTotal += val;
                    if (val < ticketMin) ticketMin = val;
                    if (val > ticketMax) ticketMax = val;
                }
            }
        }

        valorTotal = Math.round(valorTotal * 100) / 100;
        const ticketPromedio = cierresConMonto > 0 ? Math.round((valorTotal / cierresConMonto) * 100) / 100 : 0;
        const ticketMinimo = ticketMin === Number.POSITIVE_INFINITY ? 0 : ticketMin;
        const ticketMaximo = ticketMax;

        const warnings: string[] = [
            `Métricas monetarias calculadas sobre ${cierresConMonto} de ${clientesCerrados} clientes cerrados con monto capturado.`,
        ];

        if (clientesCerrados < 20) {
            warnings.push(`Muestra pequeña: se registraron ${clientesCerrados} clientes ganados en el periodo.`);
        }
        if (clientesCerrados > 0 && cierresConMonto < clientesCerrados) {
            const sinMonto = clientesCerrados - cierresConMonto;
            warnings.push(`Hay ${sinMonto} clientes marcados como ganados sin valor de cierre registrado (deal_value nulo).`);
        }

        return {
            shape: NL_RESULT_SHAPES.TABLA,
            data: {
                clientesCerrados,
                cierresConMonto,
                valorTotalVendido: valorTotal,
                ticketPromedio,
                ticketMinimo,
                ticketMaximo,
                moneda,
                periodoEtiqueta: period.label,
            },
            warnings,
            summaryMetrics: {
                clientesCerrados,
                cierresConMonto,
                valorTotalVendido: valorTotal,
            },
        };
    },
};
