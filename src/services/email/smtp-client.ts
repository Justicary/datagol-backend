import nodemailer from 'nodemailer';

/**
 * Wrapper delgado sobre `nodemailer` — una conexión SMTP efímera por envío,
 * mismo criterio que `imap-client.ts`.
 */

const SMTP_TIMEOUT_MS = 8000;

export interface SmtpConnectionConfig {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
}

export class SmtpConnectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SmtpConnectionError';
    }
}

// Puertos SMTP con modo de cifrado fijo por convención: 465 es TLS implícito
// desde el primer byte; 587/25 son texto plano que se actualiza a TLS vía
// STARTTLS. Pasar `secure: true` a un puerto STARTTLS hace que nodemailer
// intente el handshake TLS antes de que el servidor lo espere, produciendo
// el error críptico de OpenSSL "wrong version number" — se normaliza aquí
// para que un cliente que mande `port: 587, secure: true` no choque contra
// eso. En cualquier otro puerto se respeta `config.secure` tal cual.
function resolveTlsMode(config: SmtpConnectionConfig): { secure: boolean; requireTLS: boolean | undefined } {
    if (config.port === 465) {
        return { secure: true, requireTLS: undefined };
    }
    if (config.port === 587 || config.port === 25) {
        return { secure: false, requireTLS: true };
    }
    return { secure: config.secure, requireTLS: undefined };
}

function buildTransport(config: SmtpConnectionConfig) {
    const { secure, requireTLS } = resolveTlsMode(config);
    return nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure,
        requireTLS,
        auth: { user: config.user, pass: config.pass },
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
    });
}

// Firma de los dos errores de OpenSSL que produce un desajuste puerto/modo
// de cifrado (SSL implícito intentado sobre una conexión STARTTLS o
// viceversa) — se traduce a un mensaje accionable en vez del texto crudo de
// OpenSSL, que no le dice nada a quien está configurando el buzón.
const TLS_PORT_MISMATCH_PATTERN = /wrong version number|tls_validate_record_header/i;
const TLS_PORT_MISMATCH_MESSAGE =
    'Error de protocolo SSL/TLS: El puerto configurado no coincide con el modo de cifrado (usa puerto 465 para SSL/TLS o puerto 587 para STARTTLS).';

/**
 * Verifica credenciales/conectividad SMTP reales — usado por
 * `email-account.service.ts` antes de persistir una cuenta nueva.
 */
export async function verifySmtpConnection(config: SmtpConnectionConfig): Promise<void> {
    const transporter = buildTransport(config);
    try {
        await transporter.verify();
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (TLS_PORT_MISMATCH_PATTERN.test(msg)) {
            throw new SmtpConnectionError(TLS_PORT_MISMATCH_MESSAGE);
        }
        throw new SmtpConnectionError(`No se pudo conectar al servidor SMTP: ${msg}`);
    } finally {
        transporter.close();
    }
}

export interface SendEmailParams {
    fromAddress: string;
    to: string[];
    cc?: string[];
    subject: string;
    text: string;
    html?: string;
}

export interface SendEmailResult {
    providerMessageId: string | null;
}

export async function sendEmail(config: SmtpConnectionConfig, params: SendEmailParams): Promise<SendEmailResult> {
    const transporter = buildTransport(config);
    try {
        const info = await transporter.sendMail({
            from: params.fromAddress,
            to: params.to.join(', '),
            cc: params.cc && params.cc.length > 0 ? params.cc.join(', ') : undefined,
            subject: params.subject,
            text: params.text,
            html: params.html,
        });
        return { providerMessageId: info.messageId ?? null };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new SmtpConnectionError(`Error enviando el correo: ${msg}`);
    } finally {
        transporter.close();
    }
}
