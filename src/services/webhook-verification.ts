import crypto from 'crypto';

const DEFAULT_TOLERANCE_SECONDS = 1800;

export interface SignatureVerificationResult {
    valid: boolean;
    reason?: string;
}

/**
 * Verifica la firma HMAC-SHA256 de un webhook de ElevenLabs.
 *
 * Formato de cabecera `elevenlabs-signature`: `t=<unix_timestamp>,v0=<hex_hmac>`.
 * La firma se calcula sobre `${timestamp}.${rawBody}` con el secreto de la
 * organización. Se exige frescura dentro de `toleranceSeconds` para mitigar
 * ataques de repetición.
 */
export function verifyElevenLabsSignature(
    rawBody: string,
    signatureHeader: string | undefined,
    secret: string | null | undefined,
    toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS
): SignatureVerificationResult {
    if (!secret) {
        return { valid: false, reason: 'No hay secreto de firma configurado para la organización' };
    }

    if (!signatureHeader) {
        return { valid: false, reason: 'Cabecera elevenlabs-signature ausente' };
    }

    const parts = signatureHeader.split(',');
    let timestamp = '';
    const receivedSignatures: string[] = [];

    for (const part of parts) {
        const [key, value] = part.trim().split('=');
        if (key === 't') {
            timestamp = value;
        } else if (key === 'v0' || key === 'v1') {
            if (value) receivedSignatures.push(value);
        }
    }

    if (!timestamp || receivedSignatures.length === 0) {
        return { valid: false, reason: 'Cabecera elevenlabs-signature con formato inválido' };
    }

    const eventTime = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Number.isNaN(eventTime) || Math.abs(now - eventTime) > toleranceSeconds) {
        return { valid: false, reason: 'Timestamp fuera de la ventana de tolerancia (posible repetición)' };
    }

    const signedPayload = `${timestamp}.${rawBody}`;
    const expectedSignature = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

    let expectedBuffer: Buffer;
    try {
        expectedBuffer = Buffer.from(expectedSignature, 'hex');
    } catch {
        return { valid: false, reason: 'No se pudo calcular la firma esperada' };
    }

    const matches = receivedSignatures.some((sig) => {
        try {
            const sigBuffer = Buffer.from(sig, 'hex');
            return sigBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(sigBuffer, expectedBuffer);
        } catch {
            return false;
        }
    });

    if (!matches) {
        return { valid: false, reason: 'Firma HMAC no coincide' };
    }

    return { valid: true };
}
