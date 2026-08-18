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

export const cumplimientoCitasSchema = z.object({});
export type CumplimientoCitasParams = z.infer<typeof cumplimientoCitasSchema>;

export interface CumplimientoCitasData {
    totalCitas: number;
    asistieron: number;
    noAsistieron: number;
    canceladas: number;
    sinMarcar: number;
    reprogramadas: number;
    tasaAsistencia: number;
    periodoEtiqueta: string;
}

export const cumplimientoCitasIntent: NlIntentDefinition<
    CumplimientoCitasParams,
    CumplimientoCitasData
> = {
    key: NL_INTENT_KEYS.CUMPLIMIENTO_CITAS,
    category: NL_INTENT_CATEGORIES.RESULTADO,
    description: 'Tasa de asistencia a citas (cumplimiento): citas agendadas vs completadas, no_asistio, canceladas y sin desenlace marcado.',
    examples: [
        '¿Cuál es mi tasa de asistencia a citas?',
        '¿Cuántos clientes sí llegaron a su cita este mes?',
        'Cumplimiento de citas de la semana pasada',
        'Efectividad de asistencia a citas',
    ],
    resultShape: NL_RESULT_SHAPES.TABLA,
    parametersSchema: cumplimientoCitasSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: CumplimientoCitasParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<CumplimientoCitasData>> => {
        const nowIso = new Date().toISOString();
        const { data, error } = await fastify.supabaseAdmin
            .from('appointments')
            .select('status, start_time')
            .eq('organization_id', organizationId)
            .gte('start_time', period.startUtc)
            .lte('start_time', period.endUtc);

        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:cumplimiento_citas] Error consultando citas');
            throw new Error(`Error al consultar cumplimiento de citas: ${error.message}`);
        }

        let totalCitas = 0;
        let asistieron = 0;
        let noAsistieron = 0;
        let canceladas = 0;
        let sinMarcar = 0;
        let reprogramadas = 0;

        for (const item of data ?? []) {
            totalCitas++;
            const st = (item.status || 'programada').toLowerCase();
            if (st === 'completada') {
                asistieron++;
            } else if (st === 'no_asistio') {
                noAsistieron++;
            } else if (st === 'cancelada') {
                canceladas++;
            } else if (st === 'reprogramada') {
                reprogramadas++;
            } else if ((st === 'programada' || st === 'confirmada') && item.start_time < nowIso) {
                sinMarcar++;
            }
        }

        const citasConDesenlace = asistieron + noAsistieron;
        const tasaAsistencia = citasConDesenlace > 0 ? Math.round((asistieron / citasConDesenlace) * 1000) / 10 : 0;

        const warnings: string[] = [
            `Tasa de asistencia del ${tasaAsistencia}% calculada sobre ${citasConDesenlace} citas con resultado marcado (${asistieron} asistidas de ${citasConDesenlace}).`,
        ];

        if (sinMarcar > 0) {
            warnings.push(
                `Hay ${sinMarcar} citas pasadas sin desenlace marcado en el CRM; mientras no se marquen, la tasa de asistencia puede no ser representativa.`
            );
        }
        if (totalCitas < 20) {
            warnings.push(`Muestra pequeña: el cálculo se basa en ${totalCitas} citas totales.`);
        }

        return {
            shape: NL_RESULT_SHAPES.TABLA,
            data: {
                totalCitas,
                asistieron,
                noAsistieron,
                canceladas,
                sinMarcar,
                reprogramadas,
                tasaAsistencia,
                periodoEtiqueta: period.label,
            },
            warnings,
            summaryMetrics: {
                totalCitas,
                asistieron,
                tasaAsistencia,
                sinMarcar,
            },
        };
    },
};
