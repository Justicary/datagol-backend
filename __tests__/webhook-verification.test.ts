import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyElevenLabsSignature } from '../src/services/webhook-verification.js';

function signPayload(rawBody: string, secret: string, timestamp: number): string {
    const signedPayload = `${timestamp}.${rawBody}`;
    const hash = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
    return `t=${timestamp},v0=${hash}`;
}

describe('2.1 — Verificación de firma HMAC del webhook de ElevenLabs', () => {
    const secret = 'shhh-secret-de-organizacion';
    const rawBody = JSON.stringify({ type: 'post_call_transcription', data: { conversation_id: 'conv_1', agent_id: 'agent_1' } });

    it('acepta una firma válida y reciente', () => {
        const now = Math.floor(Date.now() / 1000);
        const header = signPayload(rawBody, secret, now);
        const result = verifyElevenLabsSignature(rawBody, header, secret);
        expect(result.valid).toBe(true);
    });

    it('rechaza cuando la cabecera está ausente o vacía', () => {
        const result1 = verifyElevenLabsSignature(rawBody, undefined, secret);
        expect(result1.valid).toBe(false);
        expect(result1.reason).toContain('ausente');

        const result2 = verifyElevenLabsSignature(rawBody, '', secret);
        expect(result2.valid).toBe(false);
        expect(result2.reason).toContain('ausente');
    });

    it('rechaza cuando no hay secreto configurado para la organización (null o string vacío)', () => {
        const now = Math.floor(Date.now() / 1000);
        const header = signPayload(rawBody, secret, now);

        const resultNull = verifyElevenLabsSignature(rawBody, header, null);
        expect(resultNull.valid).toBe(false);
        expect(resultNull.reason).toContain('No hay secreto');

        const resultEmpty = verifyElevenLabsSignature(rawBody, header, '');
        expect(resultEmpty.valid).toBe(false);
        expect(resultEmpty.reason).toContain('No hay secreto');
    });

    it('rechaza una firma que no coincide (secreto incorrecto)', () => {
        const now = Math.floor(Date.now() / 1000);
        const header = signPayload(rawBody, 'otro-secreto', now);
        const result = verifyElevenLabsSignature(rawBody, header, secret);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain('no coincide');
    });

    it('rechaza cabeceras con formato inválido (sin timestamp o sin firmas válidas)', () => {
        const now = Math.floor(Date.now() / 1000);

        // Sin timestamp
        const res1 = verifyElevenLabsSignature(rawBody, 'v0=abcdef1234567890', secret);
        expect(res1.valid).toBe(false);
        expect(res1.reason).toContain('formato inválido');

        // Sin firma v0/v1
        const res2 = verifyElevenLabsSignature(rawBody, `t=${now}`, secret);
        expect(res2.valid).toBe(false);
        expect(res2.reason).toContain('formato inválido');

        // Con v0 con valor vacío
        const res3 = verifyElevenLabsSignature(rawBody, `t=${now},v0=`, secret);
        expect(res3.valid).toBe(false);
        expect(res3.reason).toContain('formato inválido');

        // Clave no reconocida (ej. foo=bar) NO se interpreta como firma v0/v1
        const res4 = verifyElevenLabsSignature(rawBody, `t=${now},foo=badhash123456`, secret);
        expect(res4.valid).toBe(false);
        expect(res4.reason).toContain('formato inválido');
    });

    it('maneja adecuadamente espacios alrededor de comas e iguales (part.trim())', () => {
        const now = Math.floor(Date.now() / 1000);
        const signedPayload = `${now}.${rawBody}`;
        const hash = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

        // Cabecera con espacios al inicio/fin de cada parte
        const headerWithSpaces = ` t=${now} , v0=${hash} `;
        const result = verifyElevenLabsSignature(rawBody, headerWithSpaces, secret);
        expect(result.valid).toBe(true);
    });

    it('maneja adecuadamente el timestamp fuera de tolerancia (pasado y futuro, y límites exactos)', () => {
        const now = Math.floor(Date.now() / 1000);

        // Pasado fuera de tolerancia (3600s atras)
        const headerPast = signPayload(rawBody, secret, now - 3600);
        const resPast = verifyElevenLabsSignature(rawBody, headerPast, secret);
        expect(resPast.valid).toBe(false);
        expect(resPast.reason).toContain('tolerancia');

        // Futuro fuera de tolerancia (3600s adelante)
        const headerFuture = signPayload(rawBody, secret, now + 3600);
        const resFuture = verifyElevenLabsSignature(rawBody, headerFuture, secret);
        expect(resFuture.valid).toBe(false);
        expect(resFuture.reason).toContain('tolerancia');

        // Límite exacto de tolerancia (exactamente 1800s atras) -> DEBE SER VÁLIDO (Math.abs <= 1800)
        const headerExactBoundary = signPayload(rawBody, secret, now - 1800);
        const resExact = verifyElevenLabsSignature(rawBody, headerExactBoundary, secret, 1800);
        expect(resExact.valid).toBe(true);

        // Justo 1s sobre el límite de tolerancia (1801s atrás) -> DEBE SER RECHAZADO
        const headerOverBoundary = signPayload(rawBody, secret, now - 1801);
        const resOver = verifyElevenLabsSignature(rawBody, headerOverBoundary, secret, 1800);
        expect(resOver.valid).toBe(false);
        expect(resOver.reason).toContain('tolerancia');

        // Timestamp no numérico (NaN)
        const resNaN = verifyElevenLabsSignature(rawBody, 't=notanumber,v0=1234', secret);
        expect(resNaN.valid).toBe(false);
        expect(resNaN.reason).toContain('tolerancia');
    });

    it('utiliza DEFAULT_TOLERANCE_SECONDS (1800s) cuando no se pasa toleranceSeconds', () => {
        const now = Math.floor(Date.now() / 1000);

        // 1799 segundos atrás -> dentro del default de 1800
        const header1799 = signPayload(rawBody, secret, now - 1799);
        expect(verifyElevenLabsSignature(rawBody, header1799, secret).valid).toBe(true);

        // 1801 segundos atrás -> fuera del default de 1800
        const header1801 = signPayload(rawBody, secret, now - 1801);
        expect(verifyElevenLabsSignature(rawBody, header1801, secret).valid).toBe(false);
    });

    it('acepta la firma si al menos una de las firmas recibidas (v0 o v1) coincide (uso de .some())', () => {
        const now = Math.floor(Date.now() / 1000);
        const signedPayload = `${now}.${rawBody}`;
        const validHash = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

        // v0 es inválido, pero v1 es la firma válida
        const multiHeader = `t=${now},v0=badhash1234567890abcdef,v1=${validHash}`;
        const result = verifyElevenLabsSignature(rawBody, multiHeader, secret);
        expect(result.valid).toBe(true);
    });

    it('rechaza si el cuerpo fue alterado después de firmarlo', () => {
        const now = Math.floor(Date.now() / 1000);
        const header = signPayload(rawBody, secret, now);
        const tamperedBody = JSON.stringify({ type: 'post_call_transcription', data: { conversation_id: 'conv_2', agent_id: 'agent_1' } });
        const result = verifyElevenLabsSignature(tamperedBody, header, secret);
        expect(result.valid).toBe(false);
    });

    it('maneja firmas de longitud diferente o formato hex inválido sin fallar con excepción (sigBuffer.length === expectedBuffer.length)', () => {
        const now = Math.floor(Date.now() / 1000);
        const signedPayload = `${now}.${rawBody}`;
        const validHash = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

        // v0 tiene una longitud de buffer hex distinta (16 caracteres hex = 8 bytes) vs los 32 bytes de SHA-256
        // Si sigBuffer.length === expectedBuffer.length se mutara a true, timingSafeEqual lanzaría un TypeError descontrolado
        const headerShortHex = `t=${now},v0=1234567890abcdef,v1=${validHash}`;
        const result = verifyElevenLabsSignature(rawBody, headerShortHex, secret);
        expect(result.valid).toBe(true);

        // Solo firma de longitud incorrecta -> debe retornar rechazo por firma no coincide sin arrojar excepción
        const headerOnlyShort = `t=${now},v0=1234567890abcdef`;
        const resultOnlyShort = verifyElevenLabsSignature(rawBody, headerOnlyShort, secret);
        expect(resultOnlyShort.valid).toBe(false);
        expect(resultOnlyShort.reason).toContain('no coincide');
    });

    it('valida caracteres UTF-8 mutibyte en el cuerpo rawBody', () => {
        const now = Math.floor(Date.now() / 1000);
        const utf8Body = JSON.stringify({ mensaje: '¡Atención! Operación cancelada 🚀' });
        const header = signPayload(utf8Body, secret, now);
        const result = verifyElevenLabsSignature(utf8Body, header, secret);
        expect(result.valid).toBe(true);
    });

    it('valida con vector de prueba fijo (golden test vector)', () => {
        const fixedSecret = 'test-secret-key';
        const fixedBody = '{"hello":"world"}';
        const fixedTimestamp = 1700000000;
        const expectedHash = crypto.createHmac('sha256', fixedSecret).update(`1700000000.${fixedBody}`, 'utf8').digest('hex');

        const header = `t=${fixedTimestamp},v0=${expectedHash}`;
        const result = verifyElevenLabsSignature(fixedBody, header, fixedSecret, 9999999999);
        expect(result.valid).toBe(true);
        expect(expectedHash).toBe('33b942833cdf9870372f0f0fb2a9fed8fb41e023af292ef58530584a9270e248');
    });
});
