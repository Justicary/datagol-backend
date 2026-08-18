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

export const listadoCitasSchema = z.object({
    status: z.string().optional(),
});

export type ListadoCitasParams = z.infer<typeof listadoCitasSchema>;

export interface CitaListItem {
    id: string;
    customer_name: string | null;
    customer_phone: string | null;
    customer_email: string | null;
    start_time: string;
    end_time: string | null;
    status: string;
    service_address: string | null;
}

export const listadoCitasIntent: NlIntentDefinition<ListadoCitasParams, CitaListItem[]> = {
    key: NL_INTENT_KEYS.LISTADO_CITAS,
    category: NL_INTENT_CATEGORIES.AGENDA,
    description: 'Lista detallada de citas agendadas o programadas en el periodo con datos del cliente, estado, horario y dirección.',
    examples: [
        '¿Qué citas tengo programadas para hoy?',
        'Muéstrame las citas de esta semana',
        'Dame la lista de citas del mes pasado',
        '¿Cuáles son las citas confirmadas de hoy?',
    ],
    resultShape: NL_RESULT_SHAPES.LISTA,
    parametersSchema: listadoCitasSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        params: ListadoCitasParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<CitaListItem[]>> => {
        let query = fastify.supabaseAdmin
            .from('appointments')
            .select('id, customer_name, customer_phone, customer_email, start_time, end_time, status, service_address')
            .eq('organization_id', organizationId)
            .gte('start_time', period.startUtc)
            .lte('start_time', period.endUtc)
            .order('start_time', { ascending: true })
            .limit(50);

        if (params.status && params.status.trim() !== '') {
            query = query.eq('status', params.status.trim().toLowerCase());
        }

        const { data, error } = await query;
        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:listado_citas] Error consultando citas');
            throw new Error(`Error al consultar listado de citas: ${error.message}`);
        }

        const items: CitaListItem[] = data ?? [];
        const warnings: string[] = [];

        if (items.length === 50) {
            warnings.push('La lista muestra los primeros 50 registros del periodo para optimizar la respuesta.');
        }

        return {
            shape: NL_RESULT_SHAPES.LISTA,
            data: items,
            warnings,
            summaryMetrics: {
                totalMostrado: items.length,
            },
        };
    },
};
