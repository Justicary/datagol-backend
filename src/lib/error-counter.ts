/**
 * Contador en memoria de errores 5xx, alimentado por el `setErrorHandler`
 * global de `app.ts`. Se drena en cada envío del latido diario (Fase B.2,
 * "errores agregados") — nunca guarda el detalle del error, solo la cuenta.
 */
let count5xx = 0;

export function incrementErrorCount(statusCode: number): void {
    if (statusCode >= 500) {
        count5xx += 1;
    }
}

export function getAndResetErrorCount(): number {
    const current = count5xx;
    count5xx = 0;
    return current;
}
