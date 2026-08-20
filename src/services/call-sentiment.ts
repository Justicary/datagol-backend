/**
 * Tipo canónico para el sentimiento asignado a una llamada en call_logs.
 */
export type CallSentiment = 'Positivo' | 'Neutral' | 'Negativo';

export interface ExtractCallSentimentInput {
    analysis?: {
        call_successful?: boolean | string | null;
        transcript_summary?: string | null;
        evaluation_criteria_results?: Record<string, unknown> | null;
    } | null;
    transcript?: Array<{ role?: string; message?: string | null }> | null;
    durationSeconds?: number | null;
}

/**
 * Normaliza y extrae el sentimiento de una conversación proveniente de ElevenLabs ConvAI.
 *
 * Resuelve:
 * 1. Tipado polimórfico en `analysis.call_successful` (boolean `true`/`false` o string `"success"`/`"failure"`/`"true"`/`"false"`).
 * 2. Criterios de evaluación en `analysis.evaluation_criteria_results` cuando `call_successful` es indefinido/"unknown".
 * 3. Fallback inteligente ante latencia asíncrona (si `analysis` vino vacío o null pero la llamada tuvo interacción real >20s y >=2 turnos).
 *
 * @returns "Positivo" | "Neutral" | "Negativo"
 */
export function extractCallSentiment(data: ExtractCallSentimentInput): CallSentiment {
    const analysis = data.analysis;

    // 1. Evaluación directa de call_successful (boolean o string case-insensitive)
    if (analysis && analysis.call_successful !== undefined && analysis.call_successful !== null) {
        const cs = analysis.call_successful;
        if (cs === true) return 'Positivo';
        if (cs === false) return 'Negativo';

        if (typeof cs === 'string') {
            const normalized = cs.trim().toLowerCase();
            if (normalized === 'success' || normalized === 'true' || normalized === 'positivo') {
                return 'Positivo';
            }
            if (normalized === 'failure' || normalized === 'false' || normalized === 'negativo') {
                return 'Negativo';
            }
        }
    }

    // 2. Inspección de evaluation_criteria_results
    if (analysis?.evaluation_criteria_results && typeof analysis.evaluation_criteria_results === 'object') {
        const rawEntries = Object.values(analysis.evaluation_criteria_results);
        const results = rawEntries.map((entry) => {
            if (entry && typeof entry === 'object' && 'result' in entry) {
                return (entry as { result?: unknown }).result;
            }
            return entry;
        });

        const hasSuccess = results.some((r) => {
            if (r === true) return true;
            if (typeof r === 'string') {
                const norm = r.trim().toLowerCase();
                return norm === 'success' || norm === 'true' || norm === 'positivo';
            }
            return false;
        });

        const hasFailure = results.some((r) => {
            if (r === false) return true;
            if (typeof r === 'string') {
                const norm = r.trim().toLowerCase();
                return norm === 'failure' || norm === 'false' || norm === 'negativo';
            }
            return false;
        });

        if (hasSuccess) return 'Positivo';
        if (hasFailure) return 'Negativo';
    }

    // 3. Fallback inteligente basado en duración y transcripción
    // Si hubo conversación real (>20s y >=2 turnos con contenido) y no hubo fallo explícito
    const turns = (data.transcript || []).filter(
        (turn) => turn && typeof turn.message === 'string' && turn.message.trim().length > 0
    );
    const turnsCount = turns.length;
    const duration = data.durationSeconds ?? 0;

    if (duration >= 20 && turnsCount >= 2) {
        return 'Positivo';
    }

    return 'Neutral';
}
