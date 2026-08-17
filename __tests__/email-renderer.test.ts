import { describe, it, expect } from 'vitest';
import {
    renderEmail,
    validateEmailPayloadSize,
    MAX_EMAIL_HTML_BYTES,
} from '../src/services/email-renderer.js';
import {
    ALL_EMAIL_TEMPLATES,
    ALL_EMAIL_TYPES,
    EMAIL_TEMPLATES,
    EMAIL_TYPES,
    type EmailTemplateId,
    type EmailTypeId,
} from '../src/types/email-templates.js';
import { deriveSafeEmailTheme } from '../src/services/email-theme.js';

describe('FASE C — Motor de renderizado de correos (email-renderer.ts)', () => {
    const mockTheme = deriveSafeEmailTheme({ accentColor: '#0ea5e9', accentSecondary: '#0f172a' });

    const sampleDataByType: Record<EmailTypeId, Record<string, unknown>> = {
        [EMAIL_TYPES.CALL_SUMMARY]: {
            callerPhone: '+52 55 1234 5678',
            summary: 'El cliente llamó solicitando información sobre el servicio de IA y acordó revisión de propuesta.',
            sentiment: 'positivo',
            durationSeconds: 145,
            transcript: 'Cliente: Hola, me interesa el servicio.\nAgente: Con gusto, te comparto los detalles.',
            nextSteps: ['Enviar cotización por correo', 'Llamar de seguimiento el jueves'],
            businessName: 'Clínica Dental San Juan',
        },
        [EMAIL_TYPES.HOT_LEAD]: {
            leadName: 'María García',
            leadPhone: '+52 55 9876 5432',
            businessName: 'Taller Mecánico Express',
            inquiryReason: 'Cotización urgente para cambio de frenos y suspensión completa.',
            followupNotes: 'Mencionó que su auto está detenido y necesita el servicio hoy.',
        },
        [EMAIL_TYPES.APPOINTMENT_CONFIRMATION]: {
            customerName: 'Carlos Mendoza',
            customerPhone: '+52 55 4433 2211',
            customerEmail: 'carlos@ejemplo.com',
            startTime: 'Lunes 24 de Agosto, 10:30 AM',
            serviceAddress: 'Av. Insurgentes Sur 1200, Col. del Valle, CDMX',
            notes: 'Consulta de valoración sin costo.',
            businessName: 'Consultorio Médico Integral',
        },
        [EMAIL_TYPES.PROSPECT_SUMMARY]: {
            prospectName: 'Ana López',
            businessName: 'Despacho Contable Gómez',
            summary: 'Revisamos los planes de facturación y cumplimiento tributario para personas físicas.',
            followupNotes: 'Quedamos en enviarte la lista de documentos requeridos para la declaración anual.',
        },
        [EMAIL_TYPES.CREDITS_ALERT]: {
            organizationName: 'Agencia Digital Delta',
            remainingPercentage: 10,
            threshold: 10,
        },
    };

    describe('Matriz de 5 plantillas × 5 tipos de correo', () => {
        for (const templateId of ALL_EMAIL_TEMPLATES) {
            for (const emailType of ALL_EMAIL_TYPES) {
                it(`renderiza plantilla '${templateId}' con tipo '${emailType}' cumpliendo todos los criterios de aceptación`, () => {
                    const data = sampleDataByType[emailType];
                    const result = renderEmail(emailType, data, {
                        templateId,
                        theme: mockTheme,
                        logoUrl: 'https://cdn.datagol.net/logos/demo.png',
                        footerText: 'Aviso de privacidad en https://datagol.net/privacy',
                    });

                    // 1. Criterio Optimizado: Peso < 90 KB
                    const byteSize = Buffer.byteLength(result.html, 'utf8');
                    expect(byteSize).toBeLessThan(MAX_EMAIL_HTML_BYTES);
                    expect(byteSize).toBeGreaterThan(500); // Debe contener HTML real

                    // 2. Criterio Compatible & Ligero: Sin CSS inválido para clientes de correo
                    expect(result.html).not.toContain('rgba(');
                    expect(result.html).not.toContain('var(--');
                    expect(result.html).not.toContain('display: flex');
                    expect(result.html).not.toContain('display:flex');
                    expect(result.html).not.toContain('display: grid');
                    expect(result.html).not.toContain('display:grid');
                    expect(result.html).not.toContain('<script');
                    expect(result.html).not.toContain('background-image');

                    // 3. Estructura basada en tablas
                    expect(result.html).toContain('<table');
                    expect(result.html).toContain('</table>');

                    // 4. Texto plano generado y sincronizado
                    expect(result.text).toBeDefined();
                    expect(result.text.length).toBeGreaterThan(50);
                    expect(result.text).not.toContain('<table');
                    expect(result.text).not.toContain('<div');

                    // 5. Asunto no vacío
                    expect(result.subject).toBeDefined();
                    expect(result.subject.length).toBeGreaterThan(5);
                });
            }
        }
    });

    describe('Manejo de casos borde y ergonomía', () => {
        it('contenido largo de 3.000 caracteres no rompe el layout ni excede los 90 KB', () => {
            const longText = 'Resumen detallado de la llamada con múltiples puntos tratados. '.repeat(50); // ~3150 caracteres
            const longTranscript = 'Cliente: Necesito cotizar varios puntos.\nAgente: Con gusto, explícame.\n'.repeat(40); // ~2800 caracteres

            const result = renderEmail(
                EMAIL_TYPES.CALL_SUMMARY,
                {
                    callerPhone: '+52 55 1122 3344',
                    summary: longText,
                    transcript: longTranscript,
                    sentiment: 'neutral',
                    durationSeconds: 900,
                },
                {
                    templateId: EMAIL_TEMPLATES.PROFESIONAL,
                    theme: mockTheme,
                }
            );

            const byteSize = Buffer.byteLength(result.html, 'utf8');
            expect(byteSize).toBeLessThan(MAX_EMAIL_HTML_BYTES);
            expect(result.html).toContain(longText.slice(0, 50));
            expect(result.text).toContain(longText.slice(0, 50));
        });

        it('funciona correctamente sin logo (logoUrl: null)', () => {
            const result = renderEmail(
                EMAIL_TYPES.CALL_SUMMARY,
                sampleDataByType[EMAIL_TYPES.CALL_SUMMARY],
                {
                    templateId: EMAIL_TEMPLATES.PROFESIONAL,
                    theme: mockTheme,
                    logoUrl: null,
                }
            );

            expect(result.html).not.toContain('<img');
            expect(result.html).toContain('Reporte de Llamada');
        });

        it('los botones de acción tienen una altura mínima táctil de 44px (ergonomía)', () => {
            const result = renderEmail(
                EMAIL_TYPES.HOT_LEAD,
                sampleDataByType[EMAIL_TYPES.HOT_LEAD],
                {
                    templateId: EMAIL_TEMPLATES.PROFESIONAL,
                    theme: mockTheme,
                }
            );

            expect(result.html).toContain('min-height: 44px');
            expect(result.html).toContain('line-height: 44px');
        });

        it('validateEmailPayloadSize arroja excepción si el HTML sobrepasa 90 KB', () => {
            const smallHtml = '<html><body>ok</body></html>';
            expect(() => validateEmailPayloadSize(smallHtml)).not.toThrow();

            const hugeHtml = 'a'.repeat(95 * 1024);
            expect(() => validateEmailPayloadSize(hugeHtml)).toThrow(/excede el límite máximo permitido de 90 KB/);
        });

        it('plantilla desconocida o inválida usa profesional como fallback', () => {
            const result = renderEmail(
                EMAIL_TYPES.CALL_SUMMARY,
                sampleDataByType[EMAIL_TYPES.CALL_SUMMARY],
                {
                    templateId: 'plantilla_fantasma' as any,
                    theme: mockTheme,
                }
            );

            expect(result.templateId).toBe(EMAIL_TEMPLATES.PROFESIONAL);
            expect(result.html).toContain('Reporte de Llamada');
        });
    });
});
