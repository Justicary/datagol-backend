import { z } from 'zod';
import {
    NL_INTENT_KEYS,
    NL_INTENT_CATEGORIES,
    NL_RESULT_SHAPES,
    type NlIntentDefinition,
    type IntentExecutionResult,
} from '../../../types/natural-reports.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export const listadoCorreosEnviadosSchema = z.object({
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
});
export type ListadoCorreosEnviadosParams = z.infer<typeof listadoCorreosEnviadosSchema>;

export interface CorreoEnviadoListItem {
    id: string;
    to_addresses: string[];
    subject: string;
    status: string;
    created_at: string;
    sent_at: string | null;
}

export const listadoCorreosEnviadosIntent: NlIntentDefinition<ListadoCorreosEnviadosParams, CorreoEnviadoListItem[]> = {
    key: NL_INTENT_KEYS.LISTADO_CORREOS_ENVIADOS,
    category: NL_INTENT_CATEGORIES.CORREOS,
    description: 'Lista de correos enviados exitosamente por el sistema en el periodo, con destinatario, asunto y fecha de envío.',
    examples: [
        '¿Cuáles fueron los últimos correos enviados?',
        'Dame la lista de correos de esta semana',
        'Muéstrame los correos que se mandaron hoy',
        '¿Qué correos se enviaron el mes pasado?',
    ],
    resultShape: NL_RESULT_SHAPES.LISTA,
    parametersSchema: listadoCorreosEnviadosSchema,
    execute: async (fastify, organizationId, params, period): Promise<IntentExecutionResult<CorreoEnviadoListItem[]>> => {
        const limit = params.limit ?? DEFAULT_LIMIT;

        const { data, error } = await fastify.supabaseAdmin
            .from('email_outbox')
            .select('id, to_addresses, subject, status, created_at, sent_at')
            .eq('organization_id', organizationId)
            .eq('status', 'sent')
            .gte('created_at', period.startUtc)
            .lte('created_at', period.endUtc)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:listado_correos_enviados] Error consultando correos enviados');
            throw new Error(`Error al consultar listado de correos enviados: ${error.message}`);
        }

        const items: CorreoEnviadoListItem[] = data ?? [];
        const warnings: string[] = [];
        if (items.length === limit) {
            warnings.push(`Se muestran los primeros ${limit} correos enviados del periodo para optimizar la respuesta.`);
        }

        return {
            shape: NL_RESULT_SHAPES.LISTA,
            data: items,
            warnings,
            summaryMetrics: { totalMostrado: items.length },
        };
    },
};
