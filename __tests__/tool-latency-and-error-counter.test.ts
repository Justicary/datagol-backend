import { describe, it, expect, beforeEach } from 'vitest';
import { recordToolDuration, computeToolLatencyP95Ms, resetToolLatencyTrackerForTesting } from '../src/lib/tool-latency-tracker.js';
import { incrementErrorCount, getAndResetErrorCount } from '../src/lib/error-counter.js';

describe('src/lib/tool-latency-tracker.ts', () => {
    beforeEach(() => {
        resetToolLatencyTrackerForTesting();
    });

    it('sin muestras, reporta 0', () => {
        expect(computeToolLatencyP95Ms()).toBe(0);
    });

    it('calcula el p95 sobre un conjunto conocido de muestras', () => {
        for (let i = 1; i <= 100; i++) {
            recordToolDuration(i);
        }
        expect(computeToolLatencyP95Ms()).toBe(95);
    });

    it('con una sola muestra, el p95 es esa muestra', () => {
        recordToolDuration(42);
        expect(computeToolLatencyP95Ms()).toBe(42);
    });
});

describe('src/lib/error-counter.ts', () => {
    it('contraparte de éxito: un código 2xx/4xx no incrementa el contador de 5xx', () => {
        getAndResetErrorCount();
        incrementErrorCount(200);
        incrementErrorCount(404);
        incrementErrorCount(499);
        expect(getAndResetErrorCount()).toBe(0);
    });

    it('incrementa solo con códigos >= 500 y se drena al leer', () => {
        getAndResetErrorCount();
        incrementErrorCount(500);
        incrementErrorCount(503);
        expect(getAndResetErrorCount()).toBe(2);
        expect(getAndResetErrorCount()).toBe(0);
    });
});
