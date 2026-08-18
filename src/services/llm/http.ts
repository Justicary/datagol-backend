/**
 * Timeout duro para llamadas salientes a proveedores de LLM. Deliberadamente
 * distinto de `lib/tool-timeout.ts` (2500ms): esta llamada nunca ocurre en el
 * camino crítico de una llamada de voz — es una validación de credencial
 * disparada por un admin, o (Fase B) una revalidación antes de generar un
 * reporte. 10s es "barato" en ese contexto, no en el de un tool call en vivo.
 */
export const LLM_HTTP_TIMEOUT_MS = 10_000;

/**
 * `fetch` con `AbortController` propagado — si el proveedor no responde a
 * tiempo, se aborta la conexión de verdad en vez de solo abandonar la
 * promesa. Lanza el error de red (o de abort) tal cual; cada adaptador lo
 * clasifica como `network_error`.
 */
export async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    ms: number = LLM_HTTP_TIMEOUT_MS
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}
