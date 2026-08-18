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

export const pendientesAbiertosSchema = z.object({});
export type PendientesAbiertosParams = z.infer<typeof pendientesAbiertosSchema>;

export interface PendienteAbiertoItem {
    id: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    email: string | null;
    lifecycle_stage: string;
    created_at: string;
}

export const pendientesAbiertosIntent: NlIntentDefinition<PendientesAbiertosParams, PendienteAbiertoItem[]> = {
    key: NL_INTENT_KEYS.PENDIENTES_ABIERTOS,
    category: NL_INTENT_CATEGORIES.PENDIENTES,
    description: 'Prospectos o contactos en etapas abiertas del embudo (lead, prospecto, oportunidad) pendientes de atención o cierre.',
    examples: [
        '¿Qué prospectos tengo pendientes de atender?',
        'Lista de contactos abiertos en el pipeline',
        '¿Cuáles prospectos no han sido cerrados?',
        'Ver pendientes del embudo de ventas',
    ],
    resultShape: NL_RESULT_SHAPES.LISTA,
    parametersSchema: pendientesAbiertosSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: PendientesAbiertosParams,
        _period: ResolvedPeriod
    ): Promise<IntentExecutionResult<PendienteAbiertoItem[]>> => {
        const { data, error } = await fastify.supabaseAdmin
            .from('contacts')
            .select('id, first_name, last_name, phone, email, lifecycle_stage, created_at')
            .eq('organization_id', organizationId)
            .in('lifecycle_stage', ['lead', 'prospecto', 'oportunidad'])
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:pendientes_abiertos] Error consultando pendientes');
            throw new Error(`Error al consultar prospectos pendientes: ${error.message}`);
        }

        const items: PendienteAbiertoItem[] = data ?? [];
        const warnings: string[] = [];
        if (items.length === 50) {
            warnings.push('Se muestran los 50 contactos más recientes en etapas abiertas.');
        }

        return {
            shape: NL_RESULT_SHAPES.LISTA,
            data: items,
            warnings,
            summaryMetrics: { totalPendientes: items.length },
        };
    },
};
