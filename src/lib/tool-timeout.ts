/**
 * Presupuesto de latencia de `routes/tools/**` (AGENTS.md §3 de
 * docs/tasks/backend-implementation.md, Fase 5.1): timeout duro para
 * cualquier llamada saliente al proveedor de calendario dentro del camino
 * crítico de un tool call. Un tool que se cuelga es una llamada perdida.
 */
export const TOOL_HARD_TIMEOUT_MS = 400;

export class ToolTimeoutError extends Error {
    constructor(ms: number) {
        super(`Operación cancelada: excedió el presupuesto de ${ms} ms`);
        this.name = 'ToolTimeoutError';
    }
}

/**
 * Ejecuta `fn` con un `AbortSignal` que se dispara a los `ms` indicados.
 * `fn` debe propagar la señal a su llamada de red (ej. `fetch(url, { signal })`)
 * para que la conexión se cancele de verdad, no solo se abandone la promesa.
 */
export async function withToolTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    ms: number = TOOL_HARD_TIMEOUT_MS
): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ToolTimeoutError(ms)), ms);

    try {
        return await fn(controller.signal);
    } catch (err) {
        if (controller.signal.aborted) {
            throw new ToolTimeoutError(ms);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}
