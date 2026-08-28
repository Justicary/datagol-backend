/**
 * Ventana deslizante en memoria — mismo criterio que
 * `services/reports/nl-reports-service.ts` (checkRateLimits): sin
 * dependencia nueva, aceptable porque protege una ruta pública fuera del
 * camino crítico de voz, no un contador de facturación.
 */
const hitsByKey = new Map<string, number[]>();

function cleanOldTimestamps(timestamps: number[], windowMs: number, now: number): number[] {
    return timestamps.filter((t) => now - t < windowMs);
}

export interface RateLimitCheckResult {
    ok: boolean;
}

/**
 * Registra un intento bajo `key` y reporta si excede `limit` intentos
 * dentro de `windowMs`. El intento se cuenta siempre, incluso cuando la
 * respuesta es `ok: false` — un atacante no debe poder "gastar" el límite
 * de otro con intentos que de todas formas se rechazan.
 */
export function checkAndRecordHit(key: string, limit: number, windowMs: number, now: number = Date.now()): RateLimitCheckResult {
    const existing = cleanOldTimestamps(hitsByKey.get(key) ?? [], windowMs, now);

    if (existing.length >= limit) {
        hitsByKey.set(key, existing);
        return { ok: false };
    }

    existing.push(now);
    hitsByKey.set(key, existing);
    return { ok: true };
}

export function clearRateLimiterForTesting(): void {
    hitsByKey.clear();
}
