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

export const listadoProspectosSchema = z.object({});
export type ListadoProspectosParams = z.infer<typeof listadoProspectosSchema>;

export interface ProspectoListItem {
    id: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    email: string | null;
    lifecycle_stage: string;
    created_at: string;
}

export const listadoProspectosIntent: NlIntentDefinition<ListadoProspectosParams, ProspectoListItem[]> = {
    key: NL_INTENT_KEYS.LISTADO_PROSPECTOS,
    category: NL_INTENT_CATEGORIES.CAPTACION,
    description: 'Lista detallada de los nuevos prospectos o contactos captados en el periodo con sus datos y etapa actual.',
    examples: [
        'Dame la lista de nuevos prospectos de esta semana',
        '¿Quiénes son los últimos contactos registrados?',
        'Ver prospectos del mes pasado',
        'Lista de contactos captados hoy',
    ],
    resultShape: NL_RESULT_SHAPES.LISTA,
    parametersSchema: listadoProspectosSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: ListadoProspectosParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<ProspectoListItem[]>> => {
        const { data, error } = await fastify.supabaseAdmin
            .from('contacts')
            .select('id, first_name, last_name, phone, email, lifecycle_stage, created_at')
            .eq('organization_id', organizationId)
            .gte('created_at', period.startUtc)
            .lte('created_at', period.endUtc)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:listado_prospectos] Error consultando prospectos');
            throw new Error(`Error al consultar listado de prospectos: ${error.message}`);
        }

        const items: ProspectoListItem[] = data ?? [];
        const warnings: string[] = [];

        if (items.length === 50) {
            warnings.push('Se muestran los primeros 50 prospectos captados en el periodo.');
        }

        return {
            shape: NL_RESULT_SHAPES.LISTA,
            data: items,
            warnings,
            summaryMetrics: { totalMostrado: items.length },
        };
    },
};
