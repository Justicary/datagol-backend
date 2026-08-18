import { FastifyInstance } from 'fastify';
import {
    type UnansweredQuestionReason,
    type UnansweredQuestionRecord,
} from '../../types/natural-reports.js';

export interface RecordUnansweredQuestionParams {
    organizationId: string;
    question: string;
    reason: UnansweredQuestionReason;
    metadata?: Record<string, unknown>;
}

export async function recordUnansweredQuestion(
    fastify: FastifyInstance,
    params: RecordUnansweredQuestionParams
): Promise<void> {
    try {
        const { error } = await fastify.supabaseAdmin
            .from('unanswered_questions')
            .insert({
                organization_id: params.organizationId,
                question: params.question.trim(),
                reason: params.reason,
                metadata: params.metadata ?? {},
                created_at: new Date().toISOString(),
            });

        if (error) {
            fastify.log.warn(
                { err: error.message, organizationId: params.organizationId },
                '[UnansweredQuestions] No se pudo guardar la pregunta no resuelta'
            );
        }
    } catch (err) {
        fastify.log.warn(
            { err, organizationId: params.organizationId },
            '[UnansweredQuestions] Excepción guardando pregunta no resuelta'
        );
    }
}

export interface ListUnansweredQuestionsOptions {
    organizationId?: string;
    reason?: UnansweredQuestionReason;
    limit?: number;
}

export async function listUnansweredQuestions(
    fastify: FastifyInstance,
    options: ListUnansweredQuestionsOptions
): Promise<UnansweredQuestionRecord[]> {
    let query = fastify.supabaseAdmin
        .from('unanswered_questions')
        .select('*');

    if (options.organizationId) {
        query = query.eq('organization_id', options.organizationId);
    }

    if (options.reason) {
        query = query.eq('reason', options.reason);
    }

    const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(options.limit ?? 20);
    if (error) {
        fastify.log.error({ err: error.message }, '[UnansweredQuestions] Error listando preguntas no resueltas');
        throw new Error(`Error al listar preguntas no resueltas: ${error.message}`);
    }

    return (data ?? []) as UnansweredQuestionRecord[];
}

export interface UnansweredQuestionsSummary {
    total: number;
    porRazon: Record<string, number>;
    preguntasFrecuentes: Array<{ question: string; total: number; reason: string }>;
}

export async function getUnansweredQuestionsSummary(
    fastify: FastifyInstance,
    limit: number = 20
): Promise<UnansweredQuestionsSummary> {
    const { data, error } = await fastify.supabaseAdmin
        .from('unanswered_questions')
        .select('question, reason')
        .order('created_at', { ascending: false })
        .limit(500);

    if (error) {
        fastify.log.error({ err: error.message }, '[UnansweredQuestions] Error obteniendo resumen');
        throw new Error(`Error al obtener resumen de preguntas no resueltas: ${error.message}`);
    }

    const porRazon: Record<string, number> = {
        no_resuelta: 0,
        requiere_aclaracion: 0,
        error: 0,
    };

    const freqMap = new Map<string, { total: number; reason: string }>();

    for (const item of data ?? []) {
        const r = item.reason || 'no_resuelta';
        porRazon[r] = (porRazon[r] ?? 0) + 1;

        const qNorm = item.question.trim().toLowerCase();
        const existing = freqMap.get(qNorm);
        if (existing) {
            existing.total += 1;
        } else {
            freqMap.set(qNorm, { total: 1, reason: r });
        }
    }

    const preguntasFrecuentes = Array.from(freqMap.entries())
        .map(([question, val]) => ({ question, total: val.total, reason: val.reason }))
        .sort((a, b) => b.total - a.total)
        .slice(0, limit);

    return {
        total: (data ?? []).length,
        porRazon,
        preguntasFrecuentes,
    };
}
