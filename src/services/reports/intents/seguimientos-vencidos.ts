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

export const seguimientosVencidosSchema = z.object({});
export type SeguimientosVencidosParams = z.infer<typeof seguimientosVencidosSchema>;

export interface SeguimientosVencidosData {
    citasSinDesenlace: number;
    prospectosEstancados: number;
    totalVencidos: number;
}

export const seguimientosVencidosIntent: NlIntentDefinition<SeguimientosVencidosParams, SeguimientosVencidosData> = {
    key: NL_INTENT_KEYS.SEGUIMIENTOS_VENCIDOS,
    category: NL_INTENT_CATEGORIES.PENDIENTES,
    description: 'Resumen de tareas y seguimientos atrasados: citas pasadas sin desenlace y prospectos abiertos sin movimiento reciente.',
    examples: [
        '¿Qué seguimientos o tareas tengo vencidos?',
        '¿Hay citas o prospectos atrasados?',
        'Seguimientos pendientes y atrasados',
        '¿Qué tareas están fuera de tiempo?',
    ],
    resultShape: NL_RESULT_SHAPES.TABLA,
    parametersSchema: seguimientosVencidosSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: SeguimientosVencidosParams,
        _period: ResolvedPeriod
    ): Promise<IntentExecutionResult<SeguimientosVencidosData>> => {
        const nowIso = new Date().toISOString();
        const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        // 1. Citas pasadas sin desenlace
        const { count: citasCount } = await fastify.supabaseAdmin
            .from('appointments')
            .select('*', { count: 'exact', head: true })
            .eq('organization_id', organizationId)
            .in('status', ['programada', 'confirmada'])
            .lt('start_time', nowIso);

        // 2. Prospectos abiertos creados hace más de 7 días
        const { count: prospectosCount } = await fastify.supabaseAdmin
            .from('contacts')
            .select('*', { count: 'exact', head: true })
            .eq('organization_id', organizationId)
            .in('lifecycle_stage', ['lead', 'prospecto'])
            .lt('created_at', sevenDaysAgoIso);

        const citasSinDesenlace = citasCount ?? 0;
        const prospectosEstancados = prospectosCount ?? 0;
        const totalVencidos = citasSinDesenlace + prospectosEstancados;

        const warnings: string[] = [];
        if (citasSinDesenlace > 0) {
            warnings.push(`Hay ${citasSinDesenlace} citas pasadas pendientes de marcar resultado.`);
        }
        if (prospectosEstancados > 0) {
            warnings.push(`Hay ${prospectosEstancados} prospectos en etapa inicial con más de 7 días sin avanzar.`);
        }

        return {
            shape: NL_RESULT_SHAPES.TABLA,
            data: {
                citasSinDesenlace,
                prospectosEstancados,
                totalVencidos,
            },
            warnings,
            summaryMetrics: { totalVencidos },
        };
    },
};
