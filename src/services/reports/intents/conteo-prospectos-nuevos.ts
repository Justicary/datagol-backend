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

export const conteoProspectosNuevosSchema = z.object({});
export type ConteoProspectosNuevosParams = z.infer<typeof conteoProspectosNuevosSchema>;

export interface ConteoProspectosNuevosData {
    totalProspectosNuevos: number;
    periodoEtiqueta: string;
}

export const conteoProspectosNuevosIntent: NlIntentDefinition<
    ConteoProspectosNuevosParams,
    ConteoProspectosNuevosData
> = {
    key: NL_INTENT_KEYS.CONTEO_PROSPECTOS_NUEVOS,
    category: NL_INTENT_CATEGORIES.CAPTACION,
    description: 'Conteo de personas o contactos únicos nuevos registrados en la base de datos durante el periodo.',
    examples: [
        '¿Cuántos prospectos nuevos llegaron este mes?',
        '¿Cuántos clientes nuevos me contactaron la semana pasada?',
        'Total de prospectos captados en el periodo',
        'Nuevos contactos registrados hoy',
    ],
    resultShape: NL_RESULT_SHAPES.NUMERO,
    parametersSchema: conteoProspectosNuevosSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: ConteoProspectosNuevosParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<ConteoProspectosNuevosData>> => {
        // Trampa de esquema: contacts representa a las personas únicas, no leads (conversaciones)
        const { count, error } = await fastify.supabaseAdmin
            .from('contacts')
            .select('*', { count: 'exact', head: true })
            .eq('organization_id', organizationId)
            .gte('created_at', period.startUtc)
            .lte('created_at', period.endUtc);

        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:conteo_prospectos_nuevos] Error contando contactos');
            throw new Error(`Error al contar nuevos prospectos: ${error.message}`);
        }

        const totalProspectosNuevos = count ?? 0;
        const warnings: string[] = [];

        if (totalProspectosNuevos < 20) {
            warnings.push(`Muestra pequeña: se registraron ${totalProspectosNuevos} prospectos en el periodo.`);
        }

        return {
            shape: NL_RESULT_SHAPES.NUMERO,
            data: {
                totalProspectosNuevos,
                periodoEtiqueta: period.label,
            },
            warnings,
            summaryMetrics: { totalProspectosNuevos },
        };
    },
};
