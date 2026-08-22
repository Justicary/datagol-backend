import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyMock = vi.fn();
const sendMailMock = vi.fn();
const closeMock = vi.fn();
let lastTransportConfig: unknown = null;

vi.mock('nodemailer', () => ({
    default: {
        createTransport: vi.fn().mockImplementation((config: unknown) => {
            lastTransportConfig = config;
            return { verify: verifyMock, sendMail: sendMailMock, close: closeMock };
        }),
    },
}));

import { verifySmtpConnection, sendEmail, SmtpConnectionError } from '../src/services/email/smtp-client.js';

const CONFIG = { host: 'smtp.example.invalid', port: 465, secure: true, user: 'usuario', pass: 'clave' };

beforeEach(() => {
    vi.clearAllMocks();
    lastTransportConfig = null;
    verifyMock.mockResolvedValue(true);
    sendMailMock.mockResolvedValue({ messageId: 'msg-1@example.invalid' });
});

describe('src/services/email/smtp-client.ts', () => {
    describe('verifySmtpConnection', () => {
        it('construye el transporte con exactamente el config esperado y llama verify() + close()', async () => {
            await verifySmtpConnection(CONFIG);
            expect(lastTransportConfig).toEqual({
                host: 'smtp.example.invalid',
                port: 465,
                secure: true,
                auth: { user: 'usuario', pass: 'clave' },
                connectionTimeout: 8000,
                greetingTimeout: 8000,
                socketTimeout: 8000,
            });
            expect(verifyMock).toHaveBeenCalledTimes(1);
            expect(closeMock).toHaveBeenCalledTimes(1);
        });

        it('envuelve el error de verify() en SmtpConnectionError con el mensaje exacto, y aun así cierra el transporte', async () => {
            verifyMock.mockRejectedValueOnce(new Error('invalid login'));
            await expect(verifySmtpConnection(CONFIG)).rejects.toThrow(
                new SmtpConnectionError('No se pudo conectar al servidor SMTP: invalid login')
            );
            expect(closeMock).toHaveBeenCalledTimes(1);
        });

        it('usa String(err) cuando el error de verify() no es una instancia de Error', async () => {
            verifyMock.mockRejectedValueOnce('raw string failure');
            await expect(verifySmtpConnection(CONFIG)).rejects.toThrow(
                'No se pudo conectar al servidor SMTP: raw string failure'
            );
        });

        it('traduce "wrong version number" (desajuste puerto/TLS) al mensaje accionable en español', async () => {
            verifyMock.mockRejectedValueOnce(
                new Error('140736 SSL routines:tls_validate_record_header:wrong version number:../ssl/record.c:1000:')
            );
            await expect(verifySmtpConnection(CONFIG)).rejects.toThrow(
                new SmtpConnectionError(
                    'Error de protocolo SSL/TLS: El puerto configurado no coincide con el modo de cifrado (usa puerto 465 para SSL/TLS o puerto 587 para STARTTLS).'
                )
            );
        });

        it('traduce "tls_validate_record_header" también cuando aparece solo, sin "wrong version number"', async () => {
            verifyMock.mockRejectedValueOnce(new Error('routines:tls_validate_record_header:algo distinto'));
            await expect(verifySmtpConnection(CONFIG)).rejects.toThrow(/Error de protocolo SSL\/TLS/);
        });

        it('no traduce otros errores SMTP ajenos al desajuste de TLS (contraparte de éxito de la traducción)', async () => {
            verifyMock.mockRejectedValueOnce(new Error('535 5.7.8 Authentication failed'));
            await expect(verifySmtpConnection(CONFIG)).rejects.toThrow(
                new SmtpConnectionError('No se pudo conectar al servidor SMTP: 535 5.7.8 Authentication failed')
            );
        });
    });

    describe('normalización defensiva de TLS/STARTTLS por puerto (resolveTlsMode vía buildTransport)', () => {
        it('puerto 465: fuerza secure=true sin importar lo que mande el cliente, y no fija requireTLS', async () => {
            await verifySmtpConnection({ ...CONFIG, port: 465, secure: false });
            expect(lastTransportConfig).toMatchObject({ port: 465, secure: true, requireTLS: undefined });
        });

        it('puerto 587: fuerza secure=false y requireTLS=true aunque el cliente mande secure=true (evita "wrong version number")', async () => {
            await verifySmtpConnection({ ...CONFIG, port: 587, secure: true });
            expect(lastTransportConfig).toMatchObject({ port: 587, secure: false, requireTLS: true });
        });

        it('puerto 25: mismo tratamiento que 587 (STARTTLS obligatorio)', async () => {
            await verifySmtpConnection({ ...CONFIG, port: 25, secure: true });
            expect(lastTransportConfig).toMatchObject({ port: 25, secure: false, requireTLS: true });
        });

        it('un puerto no reservado (ej. 2525) respeta config.secure tal cual: true', async () => {
            await verifySmtpConnection({ ...CONFIG, port: 2525, secure: true });
            expect(lastTransportConfig).toMatchObject({ port: 2525, secure: true, requireTLS: undefined });
        });

        it('un puerto no reservado (ej. 2525) respeta config.secure tal cual: false', async () => {
            await verifySmtpConnection({ ...CONFIG, port: 2525, secure: false });
            expect(lastTransportConfig).toMatchObject({ port: 2525, secure: false, requireTLS: undefined });
        });

        it('sendEmail aplica la misma normalización que verifySmtpConnection (puerto 587 -> secure=false, requireTLS=true)', async () => {
            await sendEmail(
                { ...CONFIG, port: 587, secure: true },
                { fromAddress: 'a@example.invalid', to: ['b@example.invalid'], subject: 'x', text: 'y' }
            );
            expect(lastTransportConfig).toMatchObject({ port: 587, secure: false, requireTLS: true });
        });
    });

    describe('sendEmail', () => {
        const PARAMS = {
            fromAddress: 'origen@example.invalid',
            to: ['uno@example.invalid', 'dos@example.invalid'],
            subject: 'Asunto de prueba',
            text: 'Cuerpo de prueba',
        };

        it('llama sendMail con el payload exacto (to unido por coma+espacio, cc omitido, html omitido)', async () => {
            await sendEmail(CONFIG, PARAMS);
            expect(sendMailMock).toHaveBeenCalledWith({
                from: 'origen@example.invalid',
                to: 'uno@example.invalid, dos@example.invalid',
                cc: undefined,
                subject: 'Asunto de prueba',
                text: 'Cuerpo de prueba',
                html: undefined,
            });
        });

        it('incluye cc unido por coma+espacio cuando se proporciona un arreglo no vacío', async () => {
            await sendEmail(CONFIG, { ...PARAMS, cc: ['cc1@example.invalid', 'cc2@example.invalid'] });
            const callArg = sendMailMock.mock.calls[0][0] as { cc?: string };
            expect(callArg.cc).toBe('cc1@example.invalid, cc2@example.invalid');
        });

        it('cc queda undefined cuando se proporciona un arreglo vacío', async () => {
            await sendEmail(CONFIG, { ...PARAMS, cc: [] });
            const callArg = sendMailMock.mock.calls[0][0] as { cc?: string };
            expect(callArg.cc).toBeUndefined();
        });

        it('incluye html cuando se proporciona', async () => {
            await sendEmail(CONFIG, { ...PARAMS, html: '<p>hola</p>' });
            const callArg = sendMailMock.mock.calls[0][0] as { html?: string };
            expect(callArg.html).toBe('<p>hola</p>');
        });

        it('devuelve providerMessageId desde info.messageId', async () => {
            sendMailMock.mockResolvedValueOnce({ messageId: 'abc-123' });
            const result = await sendEmail(CONFIG, PARAMS);
            expect(result).toEqual({ providerMessageId: 'abc-123' });
        });

        it('providerMessageId es null cuando info.messageId está ausente', async () => {
            sendMailMock.mockResolvedValueOnce({});
            const result = await sendEmail(CONFIG, PARAMS);
            expect(result).toEqual({ providerMessageId: null });
        });

        it('envuelve el error de sendMail() en SmtpConnectionError con el mensaje exacto, y aun así cierra el transporte', async () => {
            sendMailMock.mockRejectedValueOnce(new Error('relay denied'));
            await expect(sendEmail(CONFIG, PARAMS)).rejects.toThrow(
                new SmtpConnectionError('Error enviando el correo: relay denied')
            );
            expect(closeMock).toHaveBeenCalledTimes(1);
        });

        it('usa String(err) cuando el error de sendMail() no es una instancia de Error', async () => {
            sendMailMock.mockRejectedValueOnce({ code: 'ECONNRESET' });
            await expect(sendEmail(CONFIG, PARAMS)).rejects.toThrow('Error enviando el correo: [object Object]');
        });
    });
});
