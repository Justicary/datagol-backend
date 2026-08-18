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

export const citasSinDesenlaceSchema = z.object({});
export type CitasSinDesenlaceParams = z.infer<typeof citasSinDesenlaceSchema>;

export interface CitaSinDesenlaceItem {
    id: string;
    customer_name: string | null;
    customer_phone: string | null;
    start_time: string;
    status: string;
    service_address: string | null;
}

export const citasSinDesenlaceIntent: NlIntentDefinition<CitasSinDesenlaceParams, CitaSinDesenlaceItem[]> = {
    key: NL_INTENT_KEYS.CITAS_SIN_DESENLACE,
    category: NL_INTENT_CATEGORIES.AGENDA,
    description: 'Citas pasadas que siguen en estado programada o confirmada sin haber marcado si el cliente asistió o no.',
    examples: [
        '¿Cuáles citas pasadas no tienen resultado marcado?',
        '¿Qué citas están pendientes de marcar desenlace?',
        'Citas sin marcar de la semana pasada',
        'Lista de citas pasadas sin confirmar asistencia',
    ],
    resultShape: NL_RESULT_SHAPES.LISTA,
    parametersSchema: citasSinDesenlaceSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: CitasSinDesenlaceParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<CitaSinDesenlaceItem[]>> => {
        const nowIso = new Date().toISOString();
        const effectiveEndUtc = period.endUtc < nowIso ? period.endUtc : nowIso;

        const { data, error } = await fastify.supabaseAdmin
            .from('appointments')
            .select('id, customer_name, customer_phone, start_time, status, service_address')
            .eq('organization_id', organizationId)
            .in('status', ['programada', 'confirmada'])
            .gte('start_time', period.startUtc)
            .lte('start_time', effectiveEndUtc)
            .order('start_time', { ascending: false })
            .limit(50);

        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:citas_sin_desenlace] Error consultando citas sin desenlace');
            throw new Error(`Error al consultar citas sin desenlace: ${error.message}`);
        }

        const items: CitaSinDesenlaceItem[] = data ?? [];
        const warnings: string[] = [
            'Es fundamental registrar el desenlace (asistió / no asistió) en el CRM para que los reportes de asistencia sean confiables.',
        ];

        if (items.length === 50) {
            warnings.push('Se muestran las primeras 50 citas pendientes de desenlace.');
        }

        return {
            shape: NL_RESULT_SHAPES.LISTA,
            data: items,
            warnings,
            summaryMetrics: { totalSinDesenlace: items.length },
        };
    },
};
