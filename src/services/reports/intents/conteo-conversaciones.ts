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

export const conteoConversacionesSchema = z.object({
    canal: z.string().optional(),
});

export type ConteoConversacionesParams = z.infer<typeof conteoConversacionesSchema>;

export interface ConteoConversacionesData {
    totalConversaciones: number;
    canalFiltro?: string;
    periodoEtiqueta: string;
}

export const conteoConversacionesIntent: NlIntentDefinition<
    ConteoConversacionesParams,
    ConteoConversacionesData
> = {
    key: NL_INTENT_KEYS.CONTEO_CONVERSACIONES,
    category: NL_INTENT_CATEGORIES.CAPTACION,
    description: 'Conteo total de conversaciones, llamadas o interacciones atendidas (tabla leads) en el periodo.',
    examples: [
        '¿Cuántas conversaciones tuvimos este mes?',
        '¿Cuántas llamadas entraron hoy?',
        'Total de interacciones del mes pasado',
        '¿Cuántas conversaciones de WhatsApp tuvimos esta semana?',
    ],
    resultShape: NL_RESULT_SHAPES.NUMERO,
    parametersSchema: conteoConversacionesSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        params: ConteoConversacionesParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<ConteoConversacionesData>> => {
        // Trampa de esquema: leads representa cada conversación/interacción
        let query = fastify.supabaseAdmin
            .from('leads')
            .select('*', { count: 'exact', head: true })
            .eq('organization_id', organizationId)
            .gte('created_at', period.startUtc)
            .lte('created_at', period.endUtc);

        if (params.canal && params.canal.trim() !== '') {
            query = query.eq('channel', params.canal.trim().toLowerCase());
        }

        const { count, error } = await query;
        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:conteo_conversaciones] Error contando conversaciones');
            throw new Error(`Error al contar conversaciones: ${error.message}`);
        }

        const totalConversaciones = count ?? 0;
        const warnings: string[] = [];

        if (totalConversaciones < 20) {
            warnings.push(`Muestra pequeña: se registraron ${totalConversaciones} conversaciones en el periodo.`);
        }

        return {
            shape: NL_RESULT_SHAPES.NUMERO,
            data: {
                totalConversaciones,
                canalFiltro: params.canal,
                periodoEtiqueta: period.label,
            },
            warnings,
            summaryMetrics: { totalConversaciones },
        };
    },
};
