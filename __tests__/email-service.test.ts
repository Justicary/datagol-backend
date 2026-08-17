import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    sendCallSummaryEmail,
    sendHotLeadAlertEmail,
    sendProspectSummaryEmail,
    sendAppointmentConfirmationEmail,
    sendElevenLabsCreditsAlertEmail,
    resolveOrganizationEmailOptions,
    setResendClientForTesting,
} from '../src/services/email.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { EMAIL_TEMPLATES } from '../src/types/email-templates.js';

describe('src/services/email.ts (Fase E)', () => {
    const mockSend = vi.fn();

    beforeEach(() => {
        mockSend.mockReset();
        mockSend.mockResolvedValue({ data: { id: 'email-id-abc-123' }, error: null });
        setResendClientForTesting({
            emails: { send: mockSend },
        } as any);
    });

    afterEach(() => {
        setResendClientForTesting(null);
    });

    describe('resolveOrganizationEmailOptions', () => {
        it('sin organizationId devuelve template profesional y tema default', async () => {
            const options = await resolveOrganizationEmailOptions(null);
            expect(options.templateId).toBe(EMAIL_TEMPLATES.PROFESIONAL);
            expect(options.theme).toBeDefined();
            expect(options.theme?.accent).toBe('#2563eb');
        });

        it('con organizationId inexistente o error devuelve defaults sin lanzar excepción', async () => {
            const spyMaybeSingle = vi.spyOn(supabaseAdmin, 'from').mockReturnValue({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: new Error('DB Error') }),
                    }),
                }),
            } as any);

            try {
                const options = await resolveOrganizationEmailOptions('non-existent-org-id');
                expect(options.templateId).toBe(EMAIL_TEMPLATES.PROFESIONAL);
                expect(options.theme).toBeDefined();
            } finally {
                spyMaybeSingle.mockRestore();
            }
        });
    });

    describe('sendCallSummaryEmail', () => {
        it('envía resumen con html y text plano formateados vía Resend', async () => {
            const res = await sendCallSummaryEmail({
                to: 'admin@negocio.com',
                callerPhone: '+525512345678',
                summary: 'Acordaron enviar presupuesto del servicio.',
                sentiment: 'positivo',
                durationSeconds: 120,
            });

            expect(res).toEqual({ data: { id: 'email-id-abc-123' }, error: null });
            expect(mockSend).toHaveBeenCalledTimes(1);

            const args = mockSend.mock.calls[0][0];
            expect(args.to).toBe('admin@negocio.com');
            expect(args.subject).toContain('[Llamada - POSITIVO]');
            expect(args.html).toContain('Reporte de Llamada');
            expect(args.text).toContain('=== REPORTE DE LLAMADA ===');
            expect(args.text).toContain('Acordaron enviar presupuesto del servicio.');
        });
    });

    describe('sendHotLeadAlertEmail', () => {
        it('envía alerta de prospecto caliente con CTA a Resend', async () => {
            const res = await sendHotLeadAlertEmail({
                to: 'ventas@negocio.com',
                leadName: 'Laura Morales',
                leadPhone: '+525588776655',
                businessName: 'Clínica Dental',
                inquiryReason: 'Urgencia dental en muela.',
            });

            expect(res).toBeDefined();
            expect(mockSend).toHaveBeenCalledTimes(1);

            const args = mockSend.mock.calls[0][0];
            expect(args.to).toBe('ventas@negocio.com');
            expect(args.subject).toContain('🔥 Prospecto caliente sin agendar');
            expect(args.html).toContain('🔥 Prospecto Caliente Sin Cita');
            expect(args.html).toContain('Laura Morales');
            expect(args.text).toContain('Laura Morales');
        });
    });

    describe('sendProspectSummaryEmail', () => {
        it('envía resumen al prospecto con tono de cortesía', async () => {
            const res = await sendProspectSummaryEmail({
                to: 'prospecto@gmail.com',
                prospectName: 'Roberto',
                businessName: 'Despacho Contable',
                summary: 'Revisamos dudas sobre tu declaración fiscal.',
            });

            expect(res).toBeDefined();
            expect(mockSend).toHaveBeenCalledTimes(1);

            const args = mockSend.mock.calls[0][0];
            expect(args.to).toBe('prospecto@gmail.com');
            expect(args.subject).toBe('Resumen de tu llamada con Despacho Contable');
            expect(args.html).toContain('Gracias por tu llamada');
            expect(args.html).toContain('Hola Roberto');
            expect(args.text).toContain('Hola Roberto');
        });
    });

    describe('sendAppointmentConfirmationEmail', () => {
        it('envía confirmación de cita con datos de fecha y lugar', async () => {
            const res = await sendAppointmentConfirmationEmail({
                to: 'cliente@gmail.com',
                customerName: 'Fernanda Ruiz',
                customerPhone: '+525544332211',
                startTime: 'Viernes 28 de Agosto a las 4:00 PM',
                businessName: 'Spa Relax',
                serviceAddress: 'Calle Sonora 45, Condesa',
            });

            expect(res).toBeDefined();
            expect(mockSend).toHaveBeenCalledTimes(1);

            const args = mockSend.mock.calls[0][0];
            expect(args.to).toBe('cliente@gmail.com');
            expect(args.subject).toBe('Confirmación de tu cita con Spa Relax');
            expect(args.html).toContain('📅 Cita Confirmada');
            expect(args.html).toContain('Viernes 28 de Agosto a las 4:00 PM');
            expect(args.text).toContain('Viernes 28 de Agosto a las 4:00 PM');
        });
    });

    describe('sendElevenLabsCreditsAlertEmail', () => {
        it('envía alerta de créditos con porcentaje y umbral', async () => {
            const res = await sendElevenLabsCreditsAlertEmail({
                to: 'admin@negocio.com',
                organizationName: 'Agencia Alfa',
                remainingPercentage: 5,
                threshold: 5,
            });

            expect(res).toBeDefined();
            expect(mockSend).toHaveBeenCalledTimes(1);

            const args = mockSend.mock.calls[0][0];
            expect(args.to).toBe('admin@negocio.com');
            expect(args.subject).toContain('Créditos de ElevenLabs al 5%');
            expect(args.html).toContain('⚠️ Créditos al 5%');
            expect(args.text).toContain('CRÉDITOS AL 5%');
        });
    });

    describe('Manejo de errores y servicio deshabilitado', () => {
        it('si getResendClient devuelve null (RESEND_API_KEY ausente), omite envío y retorna null', async () => {
            const origKey = process.env.RESEND_API_KEY;
            process.env.RESEND_API_KEY = '';
            setResendClientForTesting(null);

            try {
                const res = await sendCallSummaryEmail({
                    to: 'test@example.com',
                    summary: 'Resumen',
                });

                expect(res).toBeNull();
                expect(mockSend).not.toHaveBeenCalled();
            } finally {
                process.env.RESEND_API_KEY = origKey;
            }
        });

        it('si Resend responde con error (ej. status 422), registra y retorna null', async () => {
            mockSend.mockResolvedValue({
                data: null,
                error: { message: 'Invalid recipient', name: 'validation_error', statusCode: 422 },
            });

            const res = await sendCallSummaryEmail({
                to: 'test@example.com',
                summary: 'Resumen',
            });

            expect(res).toBeNull();
        });

        it('si Resend arroja excepción, la captura y retorna null sin propagar error no controlado', async () => {
            mockSend.mockRejectedValue(new Error('Resend network timeout'));

            const res = await sendCallSummaryEmail({
                to: 'test@example.com',
                summary: 'Resumen',
            });

            expect(res).toBeNull();
        });
    });
});
