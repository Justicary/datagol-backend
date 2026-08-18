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

export const atribucionOrigenSchema = z.object({});
export type AtribucionOrigenParams = z.infer<typeof atribucionOrigenSchema>;

export interface AtribucionOrigenRow {
    origen: string;
    totalConversaciones: number;
    citasAgendadas: number;
    personasUnicas: number;
    tasaConversionCita: number;
}

export interface AtribucionOrigenData {
    filas: AtribucionOrigenRow[];
    totalConversaciones: number;
    totalSinDato: number;
}

export const atribucionOrigenIntent: NlIntentDefinition<AtribucionOrigenParams, AtribucionOrigenData> = {
    key: NL_INTENT_KEYS.ATRIBUCION_ORIGEN,
    category: NL_INTENT_CATEGORIES.CAPTACION,
    description: 'Distribución de prospectos según cómo se enteraron del negocio (fuente/origen) y efectividad en agendamiento de citas.',
    examples: [
        '¿De dónde vienen mis prospectos?',
        '¿Qué canal de origen genera más clientes?',
        'Atribución de prospectos por origen de este mes',
        'Rendimiento por fuente de captación',
    ],
    resultShape: NL_RESULT_SHAPES.TABLA,
    parametersSchema: atribucionOrigenSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: AtribucionOrigenParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<AtribucionOrigenData>> => {
        const { data, error } = await fastify.supabaseAdmin
            .from('leads')
            .select('source, booked_appointment, contact_id')
            .eq('organization_id', organizationId)
            .gte('created_at', period.startUtc)
            .lte('created_at', period.endUtc);

        if (error) {
            fastify.log.error({ err: error.message, organizationId }, '[NlIntent:atribucion_origen] Error consultando origen');
            throw new Error(`Error al consultar atribución por origen: ${error.message}`);
        }

        const groups = new Map<string, { total: number; booked: number; contacts: Set<string> }>();
        let totalSinDato = 0;
        let totalConversaciones = 0;

        for (const item of data ?? []) {
            totalConversaciones++;
            const sourceKey = item.source && item.source.trim() !== '' ? item.source.trim() : 'sin_dato';
            if (sourceKey === 'sin_dato') {
                totalSinDato++;
            }

            let g = groups.get(sourceKey);
            if (!g) {
                g = { total: 0, booked: 0, contacts: new Set() };
                groups.set(sourceKey, g);
            }

            g.total++;
            if (item.booked_appointment) {
                g.booked++;
            }
            if (item.contact_id) {
                g.contacts.add(item.contact_id);
            }
        }

        const filas: AtribucionOrigenRow[] = Array.from(groups.entries()).map(([origen, stats]) => {
            const tasa = stats.total > 0 ? Math.round((stats.booked / stats.total) * 1000) / 10 : 0;
            return {
                origen,
                totalConversaciones: stats.total,
                citasAgendadas: stats.booked,
                personasUnicas: stats.contacts.size,
                tasaConversionCita: tasa,
            };
        }).sort((a, b) => b.totalConversaciones - a.totalConversaciones);

        const warnings: string[] = [];
        if (totalSinDato > 0) {
            warnings.push(`Hay ${totalSinDato} conversaciones registradas sin origen especificado (clasificadas como "sin_dato").`);
        }
        if (totalConversaciones < 20) {
            warnings.push(`Muestra pequeña: el reporte se basa en ${totalConversaciones} conversaciones en total.`);
        }

        return {
            shape: NL_RESULT_SHAPES.TABLA,
            data: {
                filas,
                totalConversaciones,
                totalSinDato,
            },
            warnings,
            summaryMetrics: { totalConversaciones, totalSinDato },
        };
    },
};
