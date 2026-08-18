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

export const conteoCitasSchema = z.object({
    status: z.string().optional(),
});

export type ConteoCitasParams = z.infer<typeof conteoCitasSchema>;

export interface ConteoCitasData {
    total: number;
    filtroEstado?: string;
    periodoEtiqueta: string;
}

export const conteoCitasIntent: NlIntentDefinition<ConteoCitasParams, ConteoCitasData> = {
    key: NL_INTENT_KEYS.CONTEO_CITAS,
    category: NL_INTENT_CATEGORIES.AGENDA,
    description: 'Conteo numérico del total de citas registradas o agendadas en el periodo seleccionado.',
    examples: [
        '¿Cuántas citas se agendaron este mes?',
        '¿Cuántas citas tuvimos la semana pasada?',
        'Total de citas agendadas hoy',
        '¿Cuántas citas canceladas hubo este mes?',
    ],
    resultShape: NL_RESULT_SHAPES.NUMERO,
    parametersSchema: conteoCitasSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        params: ConteoCitasParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<ConteoCitasData>> => {
        let query = fastify.supabaseAdmin
            .from('appointments')
            .select('*', { count: 'exact', head: true })
            .eq('organization_id', organizationId)
            .gte('start_time', period.startUtc)
            .lte('start_time', period.endUtc);

        if (params.status && params.status.trim() !== '') {
            query = query.eq('status', params.status.trim().toLowerCase());
        }

        const { count, error } = await query;
        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:conteo_citas] Error contando citas');
            throw new Error(`Error al contar citas: ${error.message}`);
        }

        const total = count ?? 0;
        const warnings: string[] = [];
        if (total < 20) {
            warnings.push(`Muestra pequeña: solo se registraron ${total} citas en el periodo.`);
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
