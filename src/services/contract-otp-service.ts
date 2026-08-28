import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { getResendClient, getFromEmail } from './email.js';
import { hashToken } from '../lib/token-hash.js';

export class ContractOtpError extends Error {
    constructor(message: string, public readonly statusCode: number) {
        super(message);
        this.name = 'ContractOtpError';
    }
}

const OTP_TTL_MINUTES = 10;
const MAX_VERIFICATION_ATTEMPTS = 5;

function generateSixDigitCode(): string {
    // 0-999999 con padding, generado con crypto (no Math.random): es la
    // evidencia de identidad del firmante de un contrato (Fase D).
    const n = crypto.randomInt(0, 1_000_000);
    return n.toString().padStart(6, '0');
}

/**
 * Genera un código de 6 dígitos, lo persiste hasheado (`contract_otp_codes`,
 * migración 69) y lo envía por correo al firmante. El código en claro NUNCA
 * se guarda — mismo criterio que `lib/token-hash.ts` para enlaces de un
 * solo uso.
 */
export async function generateAndSendContractOtp(fastify: FastifyInstance, contractId: string): Promise<void> {
    const { data: contract, error: contractError } = await fastify.supabaseAdmin
        .from('contracts')
        .select('id, signer_name, signer_email, signed_at, voided_at')
        .eq('id', contractId)
        .maybeSingle();

    if (contractError || !contract) {
        throw new ContractOtpError(`El contrato '${contractId}' no existe.`, 404);
    }
    if (contract.signed_at) {
        throw new ContractOtpError('Este contrato ya está firmado.', 409);
    }
    if (contract.voided_at) {
        throw new ContractOtpError('Este contrato fue anulado.', 409);
    }

    const code = generateSixDigitCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    const { error: insertError } = await fastify.supabaseAdmin.from('contract_otp_codes').insert({
        contract_id: contractId,
        code_hash: hashToken(code),
        channel: 'email_otp',
        sent_to: contract.signer_email,
        expires_at: expiresAt.toISOString(),
    });

    if (insertError) {
        throw new ContractOtpError(`No se pudo generar el código de verificación: ${insertError.message}`, 500);
    }

    // A diferencia del resto de services/email.ts (correo best-effort), aquí
    // una entrega fallida deja a la persona firmante sin forma de obtener el
    // código — se trata como error del endpoint, no se traga en silencio.
    const sent = await sendContractOtpEmail(contract.signer_email as string, contract.signer_name as string, code);
    if (!sent) {
        throw new ContractOtpError('No se pudo enviar el código de verificación por correo (RESEND_API_KEY no configurada o Resend respondió con error).', 502);
    }
}

async function sendContractOtpEmail(to: string, signerName: string, code: string): Promise<boolean> {
    const resend = getResendClient();
    // getResendClient() ya registra la advertencia de RESEND_API_KEY ausente.
    if (!resend) {
        return false;
    }

    const safeName = escapeHtml(signerName);
    const html = `
        <div style="font-family: sans-serif; max-width: 420px; margin: 0 auto;">
            <h2>Código de verificación</h2>
            <p>Hola ${safeName}, tu código para firmar el contrato de servicios de Datagol es:</p>
            <p style="font-size: 32px; font-weight: 700; letter-spacing: 4px; text-align: center;">${code}</p>
            <p style="color:#6b7280;font-size:12px;">Vence en ${OTP_TTL_MINUTES} minutos. Si no solicitaste este código, ignora este correo.</p>
        </div>
    `.trim();

    const response = await resend.emails.send({
        from: getFromEmail(),
        to,
        subject: 'Tu código de verificación — Contrato Datagol',
        html,
        text: `Tu código de verificación es ${code}. Vence en ${OTP_TTL_MINUTES} minutos.`,
    });

    return !response.error;
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface VerifyOtpResult {
    verified: boolean;
    reason?: string;
}

/**
 * Verifica el código contra el hash más reciente y no consumido del
 * contrato. Consumirlo (`consumed_at`) lo vuelve inmutable por el trigger
 * `forbid_consumed_otp_mutation` de la migración 69 — un código ya
 * verificado no puede reutilizarse.
 */
export async function verifyContractOtp(fastify: FastifyInstance, contractId: string, code: string): Promise<VerifyOtpResult> {
    const { data: otpRow, error } = await fastify.supabaseAdmin
        .from('contract_otp_codes')
        .select('*')
        .eq('contract_id', contractId)
        .is('consumed_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error || !otpRow) {
        return { verified: false, reason: 'No hay un código de verificación pendiente para este contrato.' };
    }

    if (otpRow.attempts >= MAX_VERIFICATION_ATTEMPTS) {
        return { verified: false, reason: 'Se alcanzó el número máximo de intentos. Solicita un nuevo código.' };
    }

    if (new Date(otpRow.expires_at).getTime() < Date.now()) {
        return { verified: false, reason: 'El código venció. Solicita uno nuevo.' };
    }

    const matches = hashToken(code) === otpRow.code_hash;

    if (!matches) {
        await fastify.supabaseAdmin.from('contract_otp_codes').update({ attempts: otpRow.attempts + 1 }).eq('id', otpRow.id);
        return { verified: false, reason: 'El código no es correcto.' };
    }

    const { error: consumeError } = await fastify.supabaseAdmin
        .from('contract_otp_codes')
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', otpRow.id)
        .is('consumed_at', null);

    if (consumeError) {
        return { verified: false, reason: 'No se pudo verificar el código. Intenta de nuevo.' };
    }

    return { verified: true };
}
