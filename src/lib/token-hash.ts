import crypto from 'crypto';

/**
 * SHA-256 de un token de un solo uso enviado por email/WhatsApp (invitación
 * de organización, oferta de lista de espera). El token crudo viaja
 * únicamente en el enlace entregado al destinatario; solo este hash se
 * persiste — nunca el valor en claro.
 */
export function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}
