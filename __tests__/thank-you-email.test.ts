import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendThankYouEmail, setResendClientForTesting } from '../src/services/email.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

describe('Agradecimiento Automático — Canal Email (Resend & Adjuntos)', () => {
    const mockSend = vi.fn();

    beforeEach(() => {
        mockSend.mockReset();
        mockSend.mockResolvedValue({ data: { id: 'email-thank-you-123' }, error: null });
        setResendClientForTesting({
            emails: { send: mockSend },
        } as any);
    });

    afterEach(() => {
        setResendClientForTesting(null);
    });

    it('envía correo de agradecimiento exitosamente con datos personalizados y plantilla', async () => {
        const response = await sendThankYouEmail({
            to: 'prospecto@cliente.com',
            prospectName: 'Lic. Roberto Garza',
            businessName: 'Corporativo Legal Garza',
            customSubject: 'Bienvenido a Corporativo Legal Garza',
            customBody: 'Hemos recibido tu solicitud de asesoría jurídica. Un abogado se comunicará contigo hoy.',
        });

        expect(response).not.toBeNull();
        expect(mockSend).toHaveBeenCalledTimes(1);

        const callArgs = mockSend.mock.calls[0][0];
        expect(callArgs.to).toBe('prospecto@cliente.com');
        expect(callArgs.subject).toBe('Bienvenido a Corporativo Legal Garza');
        expect(callArgs.html).toContain('Lic. Roberto Garza');
        expect(callArgs.html).toContain('asesoría jurídica');
        expect(callArgs.text).toContain('Lic. Roberto Garza');
    });

    it('adjunta archivo directamente cuando se provee un buffer menor o igual a 7 MB', async () => {
        const fakePdfBuffer = Buffer.from('%PDF-1.7\nSample PDF Content');

        await sendThankYouEmail({
            to: 'prospecto@cliente.com',
            prospectName: 'Claudia',
            attachmentBuffer: fakePdfBuffer,
            attachmentFileName: 'brochure_corporativo.pdf',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        const callArgs = mockSend.mock.calls[0][0];
        expect(callArgs.attachments).toBeDefined();
        expect(callArgs.attachments).toHaveLength(1);
        expect(callArgs.attachments[0].filename).toBe('brochure_corporativo.pdf');
        expect(callArgs.attachments[0].content).toEqual(fakePdfBuffer);
    });

    it('incluye botón de enlace de descarga cuando se proporciona attachmentDownloadUrl', async () => {
        await sendThankYouEmail({
            to: 'prospecto@cliente.com',
            prospectName: 'Daniela',
            attachmentDownloadUrl: 'https://storage.supabase.co/signed/brochure.pdf',
            attachmentFileName: 'presentacion_servicios.pdf',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        const callArgs = mockSend.mock.calls[0][0];
        expect(callArgs.html).toContain('https://storage.supabase.co/signed/brochure.pdf');
        expect(callArgs.html).toContain('presentacion_servicios.pdf');
    });

    it('retorna null cuando Resend responde con error', async () => {
        mockSend.mockResolvedValueOnce({
            data: null,
            error: { message: 'Invalid recipient address', name: 'validation_error' },
        });

        const response = await sendThankYouEmail({
            to: 'invalido@@dominio.com',
        });

        expect(response).toBeNull();
    });

    it('retorna null si el cliente de Resend no está configurado (API key ausente)', async () => {
        setResendClientForTesting(null);
        const prevKey = process.env.RESEND_API_KEY;
        delete process.env.RESEND_API_KEY;

        try {
            const response = await sendThankYouEmail({
                to: 'test@example.com',
            });
            expect(response).toBeNull();
        } finally {
            if (prevKey) process.env.RESEND_API_KEY = prevKey;
        }
    });
});
