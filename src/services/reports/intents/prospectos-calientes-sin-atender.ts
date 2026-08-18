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

export const prospectosCalientesSchema = z.object({});
export type ProspectosCalientesParams = z.infer<typeof prospectosCalientesSchema>;

export interface ProspectoCalienteItem {
    id: string;
    customer_name: string | null;
    customer_phone: string | null;
    created_at: string;
    temperature: string | null;
    service_summary: string | null;
    booked_appointment: boolean;
}

export interface ProspectosCalientesData {
    prospectos: ProspectoCalienteItem[];
    totalCalientesSinCita: number;
    totalSinClasificar: number;
}

export const prospectosCalientesSinAtenderIntent: NlIntentDefinition<
    ProspectosCalientesParams,
    ProspectosCalientesData
> = {
    key: NL_INTENT_KEYS.PROSPECTOS_CALIENTES_SIN_ATENDER,
    category: NL_INTENT_CATEGORIES.PENDIENTES,
    description: 'Prospectos con alta intención de compra (temperatura caliente) que no tienen cita agendada ni cierre registrado.',
    examples: [
        '¿Qué prospectos calientes no hemos atendido?',
        'Lista de leads calientes sin cita agendada',
        'Prospectos calientes pendientes de seguimiento',
        '¿Quiénes son los clientes calientes que faltan por agendar?',
    ],
    resultShape: NL_RESULT_SHAPES.LISTA,
    parametersSchema: prospectosCalientesSchema,
    execute: async (
        fastify: FastifyInstance,
        organizationId: string,
        _params: ProspectosCalientesParams,
        _period: ResolvedPeriod
    ): Promise<IntentExecutionResult<ProspectosCalientesData>> => {
        // 1. Consultar leads calientes sin cita agendada
        const { data: hotLeads, error: hotErr } = await fastify.supabaseAdmin
            .from('leads')
            .select('id, customer_name, customer_phone, created_at, temperature, service_summary, booked_appointment')
            .eq('organization_id', organizationId)
            .eq('temperature', 'caliente')
            .eq('booked_appointment', false)
            .order('created_at', { ascending: false })
            .limit(50);

        if (hotErr) {
            fastify.log.error({ err: hotErr.message, organizationId }, '[NlIntent:prospectos_calientes] Error consultando leads calientes');
            throw new Error(`Error al consultar prospectos calientes: ${hotErr.message}`);
        }

        // 2. Trampa de esquema: contar registros con temperature IS NULL
        const { count: nullCount, error: nullErr } = await fastify.supabaseAdmin
            .from('leads')
            .select('*', { count: 'exact', head: true })
            .eq('organization_id', organizationId)
            .is('temperature', null);

        if (nullErr) {
            fastify.log.warn({ err: nullErr.message, organizationId }, '[NlIntent:prospectos_calientes] Error contando nulos');
        }

        const prospectos: ProspectoCalienteItem[] = (hotLeads ?? []).map((l) => ({
            id: l.id,
            customer_name: l.customer_name,
            customer_phone: l.customer_phone,
            created_at: l.created_at,
            temperature: l.temperature,
            service_summary: l.service_summary,
            booked_appointment: l.booked_appointment ?? false,
        }));

        const totalSinClasificar = nullCount ?? 0;
        const warnings: string[] = [];

        if (totalSinClasificar > 0) {
            warnings.push(
                `Existen ${totalSinClasificar} conversaciones históricas sin clasificación de temperatura (temperature es nulo) que no fueron consideradas.`
            );
        }

        if (prospectos.length === 50) {
            warnings.push('Se muestran los 50 prospectos calientes sin cita más recientes.');
        }

        return {
            shape: NL_RESULT_SHAPES.LISTA,
            data: {
                prospectos,
                totalCalientesSinCita: prospectos.length,
                totalSinClasificar,
            },
            warnings,
            summaryMetrics: {
                totalCalientesSinCita: prospectos.length,
                totalSinClasificar,
            },
        };
    },
};
