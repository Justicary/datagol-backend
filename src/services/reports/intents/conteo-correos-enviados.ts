import { z } from 'zod';
import {
    NL_INTENT_KEYS,
    NL_INTENT_CATEGORIES,
    NL_RESULT_SHAPES,
    type NlIntentDefinition,
    type IntentExecutionResult,
} from '../../../types/natural-reports.js';

export const conteoCorreosEnviadosSchema = z.object({});
export type ConteoCorreosEnviadosParams = z.infer<typeof conteoCorreosEnviadosSchema>;

export interface ConteoCorreosEnviadosData {
    total: number;
    periodoEtiqueta: string;
    periodoAnterior?: {
        total: number;
        cambioPorcentual: number | null;
        direccion: 'arriba' | 'abajo' | 'igual';
    };
}

/**
 * Comparación contra el periodo anterior — ver docs/tasks/reportes-nl-correos-backend.md
 * §3.1. Ninguna de las 18 intenciones originales consume
 * `period.previousPeriod` (existe en `ResolvedPeriod` pero no se usaba);
 * esta es la primera. Solo se calcula cuando el llamador pidió comparación
 * (LLM clasificó `comparar_con`) — no se fuerza una segunda consulta en el
 * caso común.
 */
export const conteoCorreosEnviadosIntent: NlIntentDefinition<ConteoCorreosEnviadosParams, ConteoCorreosEnviadosData> = {
    key: NL_INTENT_KEYS.CONTEO_CORREOS_ENVIADOS,
    category: NL_INTENT_CATEGORIES.CORREOS,
    description: 'Conteo numérico del total de correos enviados exitosamente por el sistema en el periodo seleccionado.',
    examples: [
        '¿Cuántos correos se han mandado este mes?',
        '¿Cuántos emails salieron hoy?',
        'Total de correos enviados esta semana',
        '¿Cuántos correos mandamos comparado con el mes pasado?',
    ],
    resultShape: NL_RESULT_SHAPES.NUMERO,
    parametersSchema: conteoCorreosEnviadosSchema,
    execute: async (fastify, organizationId, _params, period): Promise<IntentExecutionResult<ConteoCorreosEnviadosData>> => {
        const { count, error } = await fastify.supabaseAdmin
            .from('email_outbox')
            .select('*', { count: 'exact', head: true })
            .eq('organization_id', organizationId)
            .eq('status', 'sent')
            .gte('created_at', period.startUtc)
            .lte('created_at', period.endUtc);

        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:conteo_correos_enviados] Error contando correos enviados');
            throw new Error(`Error al contar correos enviados: ${error.message}`);
        }

        const total = count ?? 0;
        const warnings: string[] = [];
        if (total < 5) {
            warnings.push(`Muestra pequeña: solo se enviaron ${total} correos en el periodo.`);
        }

        const data: ConteoCorreosEnviadosData = { total, periodoEtiqueta: period.label };

        if (period.previousPeriod) {
            const { count: previousCount, error: previousError } = await fastify.supabaseAdmin
                .from('email_outbox')
                .select('*', { count: 'exact', head: true })
                .eq('organization_id', organizationId)
                .eq('status', 'sent')
                .gte('created_at', period.previousPeriod.startUtc)
                .lte('created_at', period.previousPeriod.endUtc);

            if (!previousError) {
                const previousTotal = previousCount ?? 0;
                const cambioPorcentual = previousTotal === 0 ? null : Math.round(((total - previousTotal) / previousTotal) * 1000) / 10;
                data.periodoAnterior = {
                    total: previousTotal,
                    cambioPorcentual,
                    direccion: total > previousTotal ? 'arriba' : total < previousTotal ? 'abajo' : 'igual',
                };
            } else {
                fastify.log.warn(
                    { err: previousError.message, organizationId },
                    '[NlIntent:conteo_correos_enviados] No se pudo calcular la comparación con el periodo anterior'
                );
            }
        }

        return {
            shape: NL_RESULT_SHAPES.NUMERO,
            data,
            warnings,
            summaryMetrics: { total },
        };
    },
};
