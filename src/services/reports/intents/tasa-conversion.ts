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

export const tasaConversionSchema = z.object({});
export type TasaConversionParams = z.infer<typeof tasaConversionSchema>;

export interface TasaConversionData {
    totalConversaciones: number;
    citasAgendadas: number;
    tasaConversacionACita: number;
    totalProspectos: number;
    clientesGanados: number;
    tasaProspectoACliente: number;
    periodoEtiqueta: string;
}

export const tasaConversionIntent: NlIntentDefinition<
    TasaConversionParams,
    TasaConversionData
> = {
    key: NL_INTENT_KEYS.TASA_CONVERSION,
    category: NL_INTENT_CATEGORIES.RESULTADO,
    description: 'Tasas de conversión del embudo comercial: porcentaje de conversaciones que agendan cita y porcentaje de prospectos que cierran como cliente.',
    examples: [
        '¿Cuál es mi tasa de conversión?',
        '¿Qué porcentaje de llamadas se convierte en cita?',
        'Conversión de prospectos a clientes de este mes',
        'Efectividad del embudo de ventas',
    ],
    resultShape: NL_RESULT_SHAPES.TABLA,
    parametersSchema: tasaConversionSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: TasaConversionParams,
        period: ResolvedPeriod
    ): Promise<IntentExecutionResult<TasaConversionData>> => {
        // 1. Conversaciones e intención de cita (leads)
        const { data: leadsData, error: leadsErr } = await fastify.supabaseAdmin
            .from('leads')
            .select('booked_appointment')
            .eq('organization_id', organizationId)
            .gte('created_at', period.startUtc)
            .lte('created_at', period.endUtc);

        if (leadsErr) {
            fastify.log.error({ err: leadsErr.message, organizationId }, '[NlIntent:tasa_conversion] Error consultando leads');
            throw new Error(`Error al consultar conversaciones para conversión: ${leadsErr.message}`);
        }

        const totalConversaciones = leadsData?.length ?? 0;
        let citasAgendadas = 0;
        for (const l of leadsData ?? []) {
            if (l.booked_appointment) citasAgendadas++;
        }
        const tasaConversacionACita =
            totalConversaciones > 0 ? Math.round((citasAgendadas / totalConversaciones) * 1000) / 10 : 0;

        // 2. Prospectos y clientes ganados (contacts)
        const { data: contactsData, error: contactsErr } = await fastify.supabaseAdmin
            .from('contacts')
            .select('lifecycle_stage, won_at')
            .eq('organization_id', organizationId)
            .gte('created_at', period.startUtc)
            .lte('created_at', period.endUtc);

        if (contactsErr) {
            fastify.log.error({ err: contactsErr.message, organizationId }, '[NlIntent:tasa_conversion] Error consultando contactos');
            throw new Error(`Error al consultar contactos para conversión: ${contactsErr.message}`);
        }

        const totalProspectos = contactsData?.length ?? 0;
        let clientesGanados = 0;
        for (const c of contactsData ?? []) {
            if (c.lifecycle_stage === 'cliente' || c.won_at) {
                clientesGanados++;
            }
        }
        const tasaProspectoACliente =
            totalProspectos > 0 ? Math.round((clientesGanados / totalProspectos) * 1000) / 10 : 0;

        const warnings: string[] = [
            `Conversión a cita: ${tasaConversacionACita}% (${citasAgendadas} citas de ${totalConversaciones} conversaciones).`,
            `Conversión a cliente: ${tasaProspectoACliente}% (${clientesGanados} ganados de ${totalProspectos} prospectos creados).`,
        ];

        if (totalConversaciones < 20 || totalProspectos < 20) {
            warnings.push('Muestra pequeña: las tasas de conversión se calcularon con menos de 20 casos.');
        }

        return {
            shape: NL_RESULT_SHAPES.TABLA,
            data: {
                totalConversaciones,
                citasAgendadas,
                tasaConversacionACita,
                totalProspectos,
                clientesGanados,
                tasaProspectoACliente,
                periodoEtiqueta: period.label,
            },
            warnings,
            summaryMetrics: {
                tasaConversacionACita,
                tasaProspectoACliente,
                totalConversaciones,
                totalProspectos,
            },
        };
    },
};
