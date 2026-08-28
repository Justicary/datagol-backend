import { describe, it, expect, beforeEach } from 'vitest';
import { checkAndRecordHit, clearRateLimiterForTesting } from '../src/lib/rate-limiter.js';

describe('src/lib/rate-limiter.ts', () => {
    beforeEach(() => {
        clearRateLimiterForTesting();
    });

    it('contraparte de éxito: permite hasta el límite dentro de la ventana', () => {
        const now = 1_000_000;
        expect(checkAndRecordHit('k', 3, 60_000, now).ok).toBe(true);
        expect(checkAndRecordHit('k', 3, 60_000, now + 1).ok).toBe(true);
        expect(checkAndRecordHit('k', 3, 60_000, now + 2).ok).toBe(true);
    });

    it('rechaza la petición que excede el límite dentro de la ventana', () => {
        const now = 1_000_000;
        checkAndRecordHit('k', 2, 60_000, now);
        checkAndRecordHit('k', 2, 60_000, now + 1);
        const third = checkAndRecordHit('k', 2, 60_000, now + 2);
        expect(third.ok).toBe(false);
    });

    it('un intento rechazado también cuenta — no se puede reintentar sin límite', () => {
        const now = 1_000_000;
        checkAndRecordHit('k', 1, 60_000, now);
        const second = checkAndRecordHit('k', 1, 60_000, now + 1);
        const third = checkAndRecordHit('k', 1, 60_000, now + 2);
        expect(second.ok).toBe(false);
        expect(third.ok).toBe(false);
    });

    it('pasada la ventana, el contador se reinicia', () => {
        const now = 1_000_000;
        checkAndRecordHit('k', 1, 60_000, now);
        const withinWindow = checkAndRecordHit('k', 1, 60_000, now + 1000);
        const afterWindow = checkAndRecordHit('k', 1, 60_000, now + 61_000);
        expect(withinWindow.ok).toBe(false);
        expect(afterWindow.ok).toBe(true);
    });

    it('claves distintas no se afectan entre sí', () => {
        const now = 1_000_000;
        checkAndRecordHit('token-a', 1, 60_000, now);
        const other = checkAndRecordHit('token-b', 1, 60_000, now);
        expect(other.ok).toBe(true);
    });
});
