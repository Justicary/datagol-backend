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

export const citasPorEstadoSchema = z.object({});
export type CitasPorEstadoParams = z.infer<typeof citasPorEstadoSchema>;

export interface CitasPorEstadoRow {
    estado: string;
    total: number;
    porcentaje: number;
}

export interface CitasPorEstadoData {
    filas: CitasPorEstadoRow[];
    totalGeneral: number;
}

const ALL_STATUSES = ['programada', 'confirmada', 'completada', 'no_asistio', 'cancelada', 'reprogramada'];

export const citasPorEstadoIntent: NlIntentDefinition<CitasPorEstadoParams, CitasPorEstadoData> = {
    key: NL_INTENT_KEYS.CITAS_POR_ESTADO,
    category: NL_INTENT_CATEGORIES.AGENDA,
    description: 'Distribución y desglose de citas por su estado (programada, confirmada, completada, no_asistio, cancelada, reprogramada) en el periodo.',
    examples: [
        '¿Cómo se distribuyen mis citas por estado?',
        'Desglose de citas por estado de este mes',
        '¿Cuántas citas fueron confirmadas, completadas o canceladas?',
        'Estatus de las citas de la semana pasada',
    ],
    resultShape: NL_RESULT_SHAPES.TABLA,
    parametersSchema: citasPorEstadoSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: CitasPorEstadoParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<CitasPorEstadoData>> => {
        const { data, error } = await fastify.supabaseAdmin
            .from('appointments')
            .select('status')
            .eq('organization_id', organizationId)
            .gte('start_time', period.startUtc)
            .lte('start_time', period.endUtc);

        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:citas_por_estado] Error consultando citas');
            throw new Error(`Error al consultar citas por estado: ${error.message}`);
        }

        const countsByStatus = new Map<string, number>();
        for (const s of ALL_STATUSES) {
            countsByStatus.set(s, 0);
        }

        let totalGeneral = 0;
        for (const item of data ?? []) {
            const st = (item.status || 'programada').toLowerCase();
            countsByStatus.set(st, (countsByStatus.get(st) ?? 0) + 1);
            totalGeneral++;
        }

        const filas: CitasPorEstadoRow[] = ALL_STATUSES.map((estado) => {
            const count = countsByStatus.get(estado) ?? 0;
            const porcentaje = totalGeneral > 0 ? Math.round((count / totalGeneral) * 1000) / 10 : 0;
            return {
                estado,
                total: count,
                porcentaje,
            };
        });

        const warnings: string[] = [];
        if (totalGeneral < 20) {
            warnings.push(`Muestra pequeña: los porcentajes se basan en ${totalGeneral} citas en total.`);
        }

        return {
            shape: NL_RESULT_SHAPES.TABLA,
            data: {
                filas,
                totalGeneral,
            },
            warnings,
            summaryMetrics: { totalGeneral },
        };
    },
};
