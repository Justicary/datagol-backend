/**
 * Ventana en memoria de las duraciones de `routes/tools/**` (AGENTS.md §3),
 * alimentada por el hook `onResponse` ya existente en `routes/tools/index.ts`.
 * Sirve un único propósito: darle al latido diario (Fase B.2, "latencia
 * p95") un número real en vez de uno inventado. No es un sistema de
 * observabilidad — para eso está §14, fuera de alcance de esta tarea.
 */
const MAX_SAMPLES = 500;
let samples: number[] = [];

export function recordToolDuration(durationMs: number): void {
    samples.push(durationMs);
    if (samples.length > MAX_SAMPLES) {
        samples = samples.slice(samples.length - MAX_SAMPLES);
    }
}

export function computeToolLatencyP95Ms(): number {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return Math.round(sorted[index]);
}

export function resetToolLatencyTrackerForTesting(): void {
    samples = [];
}
