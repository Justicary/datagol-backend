import { z } from 'zod';
import {
    NL_INTENT_KEYS,
    NL_INTENT_CATEGORIES,
    NL_RESULT_SHAPES,
    type NlIntentDefinition,
    type IntentExecutionResult,
} from '../../../types/natural-reports.js';

const MAX_ITEMS = 15;

export const correosConErrorSchema = z.object({});
export type CorreosConErrorParams = z.infer<typeof correosConErrorSchema>;

export interface CorreoConErrorListItem {
    id: string;
    to_addresses: string[];
    subject: string;
    error_message: string | null;
    created_at: string;
}

export const correosConErrorIntent: NlIntentDefinition<CorreosConErrorParams, CorreoConErrorListItem[]> = {
    key: NL_INTENT_KEYS.CORREOS_CON_ERROR,
    category: NL_INTENT_CATEGORIES.CORREOS,
    description: 'Correos que fallaron al enviarse en el periodo, con el destinatario, asunto y la causa del fallo.',
    examples: [
        '¿Qué correos fallaron?',
        '¿Hay errores de entrega de correo?',
        '¿Cuáles correos no se pudieron enviar este mes?',
        'Muéstrame los correos con error de esta semana',
    ],
    resultShape: NL_RESULT_SHAPES.LISTA,
    parametersSchema: correosConErrorSchema,
    execute: async (fastify, organizationId, _params, period): Promise<IntentExecutionResult<CorreoConErrorListItem[]>> => {
        const { data, error } = await fastify.supabaseAdmin
            .from('email_outbox')
            .select('id, to_addresses, subject, error_message, created_at')
            .eq('organization_id', organizationId)
            .eq('status', 'failed')
            .gte('created_at', period.startUtc)
            .lte('created_at', period.endUtc)
            .order('created_at', { ascending: false })
            .limit(MAX_ITEMS);

        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:correos_con_error] Error consultando correos con error');
            throw new Error(`Error al consultar correos con error: ${error.message}`);
        }

        const items: CorreoConErrorListItem[] = data ?? [];
        const warnings: string[] = [];
        if (items.length === MAX_ITEMS) {
            warnings.push(`Se muestran los primeros ${MAX_ITEMS} correos con error del periodo para optimizar la respuesta.`);
        }
        if (items.length === 0) {
            warnings.push('No se registraron correos con error de envío en el periodo consultado.');
        }

        return {
            shape: NL_RESULT_SHAPES.LISTA,
            data: items,
            warnings,
            summaryMetrics: { totalMostrado: items.length },
        };
    },
};
