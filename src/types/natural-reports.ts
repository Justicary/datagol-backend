import { FastifyInstance } from 'fastify';
import { z } from 'zod';

export const NL_INTENT_CATEGORIES = {
    AGENDA: 'agenda',
    PENDIENTES: 'pendientes',
    CAPTACION: 'captacion',
    COSTO: 'costo',
    RESULTADO: 'resultado',
    CORREOS: 'correos',
} as const;

export type NlIntentCategory = (typeof NL_INTENT_CATEGORIES)[keyof typeof NL_INTENT_CATEGORIES];

export const NL_INTENT_KEYS = {
    // Agenda (4)
    LISTADO_CITAS: 'listado_citas',
    CONTEO_CITAS: 'conteo_citas',
    CITAS_POR_ESTADO: 'citas_por_estado',
    CITAS_SIN_DESENLACE: 'citas_sin_desenlace',

    // Pendientes (3)
    PENDIENTES_ABIERTOS: 'pendientes_abiertos',
    SEGUIMIENTOS_VENCIDOS: 'seguimientos_vencidos',
    PROSPECTOS_CALIENTES_SIN_ATENDER: 'prospectos_calientes_sin_atender',

    // Captación (4)
    CONTEO_PROSPECTOS_NUEVOS: 'conteo_prospectos_nuevos',
    LISTADO_PROSPECTOS: 'listado_prospectos',
    CONTEO_CONVERSACIONES: 'conteo_conversaciones',
    ATRIBUCION_ORIGEN: 'atribucion_origen',

    // Costo (4)
    COSTO_TOTAL: 'costo_total',
    COSTO_POR_CANAL: 'costo_por_canal',
    COSTO_POR_PROSPECTO: 'costo_por_prospecto',
    COSTO_POR_CITA: 'costo_por_cita',

    // Resultado (3)
    RESULTADO_NEGOCIO: 'resultado_negocio',
    CUMPLIMIENTO_CITAS: 'cumplimiento_citas',
    TASA_CONVERSION: 'tasa_conversion',

    // Correos (4)
    CONTEO_CORREOS_ENVIADOS: 'conteo_correos_enviados',
    LISTADO_CORREOS_ENVIADOS: 'listado_correos_enviados',
    CORREOS_CON_ERROR: 'correos_con_error',
    RESUMEN_CORREOS_RECIBIDOS: 'resumen_correos_recibidos',
} as const;

export type NlIntentKey = (typeof NL_INTENT_KEYS)[keyof typeof NL_INTENT_KEYS];
export const ALL_NL_INTENT_KEYS: readonly NlIntentKey[] = Object.values(NL_INTENT_KEYS);

export const NL_RESULT_SHAPES = {
    NUMERO: 'numero',
    TABLA: 'tabla',
    LISTA: 'lista',
} as const;

export type NlResultShape = (typeof NL_RESULT_SHAPES)[keyof typeof NL_RESULT_SHAPES];

export const NL_PERIOD_TYPES = {
    HOY: 'hoy',
    AYER: 'ayer',
    ESTA_SEMANA: 'esta_semana',
    SEMANA_PASADA: 'semana_pasada',
    ESTE_MES: 'este_mes',
    MES_PASADO: 'mes_pasado',
    ULTIMOS_N_DIAS: 'ultimos_n_dias',
    RANGO_EXPLICITO: 'rango_explicito',
} as const;

export type NlPeriodType = (typeof NL_PERIOD_TYPES)[keyof typeof NL_PERIOD_TYPES];

export const NL_GROUP_BY_DIMENSIONS = {
    DIA: 'dia',
    SEMANA: 'semana',
    MES: 'mes',
    CANAL: 'canal',
    ETAPA: 'etapa',
    ORIGEN: 'origen',
} as const;

export type NlGroupByDimension = (typeof NL_GROUP_BY_DIMENSIONS)[keyof typeof NL_GROUP_BY_DIMENSIONS];

export const NL_COMPARE_TO_DIMENSIONS = {
    PERIODO_ANTERIOR: 'periodo_anterior',
    MISMO_PERIODO_MES_PASADO: 'mismo_periodo_mes_pasado',
} as const;

export type NlCompareToDimension = (typeof NL_COMPARE_TO_DIMENSIONS)[keyof typeof NL_COMPARE_TO_DIMENSIONS];

export interface ResolvedPeriod {
    type: NlPeriodType;
    startUtc: string;
    endUtc: string;
    startLocal: string;
    endLocal: string;
    label: string;
    timezone: string;
    previousPeriod?: {
        startUtc: string;
        endUtc: string;
        label: string;
    };
}

export interface IntentExecutionResult<TData = unknown> {
    shape: NlResultShape;
    data: TData;
    warnings: string[];
    summaryMetrics?: Record<string, unknown>;
}

export interface NlIntentDefinition<TParams = Record<string, unknown>, TData = unknown> {
    key: NlIntentKey;
    category: NlIntentCategory;
    description: string;
    examples: readonly string[];
    resultShape: NlResultShape;
    parametersSchema: z.ZodType<TParams>;
    execute: (
        fastify: FastifyInstance,
        organizationId: string,
        params: TParams,
        period: ResolvedPeriod
    ) => Promise<IntentExecutionResult<TData>>;
}

export type UnansweredQuestionReason = 'no_resuelta' | 'requiere_aclaracion' | 'error';

export interface UnansweredQuestionRecord {
    id: string;
    organization_id: string;
    question: string;
    reason: UnansweredQuestionReason;
    metadata: Record<string, unknown>;
    created_at: string;
}

export type NlTranslationStatus = 'success' | 'requiere_aclaracion' | 'no_resuelta';

export interface NlTranslationSuccess {
    status: 'success';
    intent: NlIntentKey;
    parameters: Record<string, unknown>;
    interpretation: string;
}

export interface NlTranslationClarification {
    status: 'requiere_aclaracion';
    preguntaAclaracion: string;
    interpretation: string;
}

export interface NlTranslationUnresolved {
    status: 'no_resuelta';
    reason: string;
    interpretation: string;
}

export type NlTranslationResult = NlTranslationSuccess | NlTranslationClarification | NlTranslationUnresolved;

export interface AskReportSuccessResponse {
    success: true;
    status: 'success';
    intent: NlIntentKey;
    category: NlIntentCategory;
    interpretation: string;
    period: ResolvedPeriod;
    shape: NlResultShape;
    data: unknown;
    narrative: string | null;
    warnings: string[];
    executionTimeMs: number;
    cached?: boolean;
}

export interface AskReportClarificationResponse {
    success: true;
    status: 'requiere_aclaracion';
    interpretation: string;
    preguntaAclaracion: string;
}

export interface AskReportUnresolvedResponse {
    success: true;
    status: 'no_resuelta';
    interpretation: string;
    reason: string;
}

export type AskReportResponse = AskReportSuccessResponse | AskReportClarificationResponse | AskReportUnresolvedResponse;
