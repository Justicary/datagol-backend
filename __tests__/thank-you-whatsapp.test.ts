import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendThankYouWhatsApp, isWithinWhatsApp24hWindow } from '../src/services/thank-you-whatsapp.js';
import * as secretService from '../src/services/secret-service.js';
import * as rateService from '../src/services/rate-service.js';
import type { FastifyInstance } from 'fastify';

describe('Agradecimiento Automático — Canal WhatsApp (Meta API & 24h Window)', () => {
    let fakeFastify: any;
    let mockInsert: any;
    let originalFetch: any;

    beforeEach(() => {
        originalFetch = global.fetch;
        mockInsert = vi.fn().mockResolvedValue({ error: null });

        fakeFastify = {
            supabaseAdmin: {
                from: vi.fn(),
            },
            log: {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
            },
        };
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    describe('isWithinWhatsApp24hWindow', () => {
        it('retorna true si existen mensajes entrantes en las últimas 24 horas', async () => {
            fakeFastify.supabaseAdmin.from.mockReturnValue({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        eq: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                gte: vi.fn().mockResolvedValue({ count: 2, error: null }),
                            }),
                        }),
                    }),
                }),
            });

            const result = await isWithinWhatsApp24hWindow(fakeFastify, 'org-123', 'contact-123');
            expect(result).toBe(true);
        });

        it('retorna false si no hay mensajes entrantes o son anteriores a 24 horas', async () => {
            fakeFastify.supabaseAdmin.from.mockReturnValue({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        eq: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                gte: vi.fn().mockResolvedValue({ count: 0, error: null }),
                            }),
                        }),
                    }),
                }),
            });

            const result = await isWithinWhatsApp24hWindow(fakeFastify, 'org-123', 'contact-123');
            expect(result).toBe(false);
        });
    });

    describe('sendThankYouWhatsApp', () => {
        it('dentro de la ventana de 24h: envía mensaje libre de texto sin costo de plantilla', async () => {
            vi.spyOn(secretService, 'getSecret').mockResolvedValue('fake-wa-token');
            vi.spyOn(rateService, 'getRate').mockResolvedValue({ unitRateUsd: 0.0 } as any);

            // Mock fetch a Meta Graph API
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ messages: [{ id: 'wamid.HBgL...' }] }),
            } as any);

            // Mock organizaciones y mensajes entrantes
            fakeFastify.supabaseAdmin.from.mockImplementation((table: string) => {
                if (table === 'organizations') {
                    return {
                        select: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                maybeSingle: vi.fn().mockResolvedValue({
                                    data: { whatsapp_phone_number_id: 'phone-id-123', name: 'Dental Plus' },
                                    error: null,
                                }),
                            }),
                        }),
                    };
                }
                if (table === 'whatsapp_messages') {
                    return {
                        select: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                eq: vi.fn().mockReturnValue({
                                    eq: vi.fn().mockReturnValue({
                                        gte: vi.fn().mockResolvedValue({ count: 1, error: null }),
                                    }),
                                }),
                            }),
                        }),
                        insert: mockInsert,
                    };
                }
                if (table === 'usage_events') {
                    return { insert: mockInsert };
                }
                return {};
            });

            const result = await sendThankYouWhatsApp(fakeFastify, {
                organizationId: 'org-123',
                contactId: 'contact-123',
                phoneE164: '+525512345678',
                prospectName: 'Eduardo',
                businessName: 'Dental Plus',
                customBody: '¡Hola Eduardo! Recibimos tu solicitud.',
            });

            expect(result.sent).toBe(true);
            expect(result.waMessageId).toBe('wamid.HBgL...');
            expect(global.fetch).toHaveBeenCalledTimes(1);

            // Verifica payload enviado a Meta
            const fetchCall = vi.mocked(global.fetch).mock.calls[0];
            const requestBody = JSON.parse(fetchCall[1]?.body as string);
            expect(requestBody.type).toBe('text');
            expect(requestBody.text.body).toContain('¡Hola Eduardo! Recibimos tu solicitud.');
        });

        it('fuera de ventana de 24h con plantilla configurada: envía mensaje de plantilla e inserta usage_event', async () => {
            vi.spyOn(secretService, 'getSecret').mockResolvedValue('fake-wa-token');
            vi.spyOn(rateService, 'getRate').mockResolvedValue({ unitRateUsd: 0.008 } as any);

            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ messages: [{ id: 'wamid.template.123' }] }),
            } as any);

            fakeFastify.supabaseAdmin.from.mockImplementation((table: string) => {
                if (table === 'organizations') {
                    return {
                        select: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                maybeSingle: vi.fn().mockResolvedValue({
                                    data: { whatsapp_phone_number_id: 'phone-id-123', name: 'AutoServicio' },
                                    error: null,
                                }),
                            }),
                        }),
                    };
                }
                if (table === 'whatsapp_messages') {
                    return {
                        select: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                eq: vi.fn().mockReturnValue({
                                    eq: vi.fn().mockReturnValue({
                                        gte: vi.fn().mockResolvedValue({ count: 0, error: null }),
                                    }),
                                }),
                            }),
                        }),
                        insert: mockInsert,
                    };
                }
                if (table === 'usage_events') {
                    return { insert: mockInsert };
                }
                return {};
            });

            const result = await sendThankYouWhatsApp(fakeFastify, {
                organizationId: 'org-123',
                contactId: 'contact-123',
                phoneE164: '+525512345678',
                prospectName: 'Mariana',
                whatsappTemplateName: 'bienvenida_lead_2026',
            });

            expect(result.sent).toBe(true);
            expect(result.waMessageId).toBe('wamid.template.123');

            const fetchCall = vi.mocked(global.fetch).mock.calls[0];
            const requestBody = JSON.parse(fetchCall[1]?.body as string);
            expect(requestBody.type).toBe('template');
            expect(requestBody.template.name).toBe('bienvenida_lead_2026');

            // Verifica registro de consumo en usage_events
            expect(mockInsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    provider: 'meta',
                    unit_type: 'wa_utility_mx',
                    unit_rate_usd: 0.008,
                })
            );
        });

        it('fuera de ventana de 24h SIN plantilla configurada: omite deliberadamente con skipReason sin lanzar excepción', async () => {
            vi.spyOn(secretService, 'getSecret').mockResolvedValue('fake-wa-token');

            fakeFastify.supabaseAdmin.from.mockImplementation((table: string) => {
                if (table === 'organizations') {
                    return {
                        select: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                maybeSingle: vi.fn().mockResolvedValue({
                                    data: { whatsapp_phone_number_id: 'phone-id-123', name: 'AutoServicio' },
                                    error: null,
                                }),
                            }),
                        }),
                    };
                }
                if (table === 'whatsapp_messages') {
                    return {
                        select: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                eq: vi.fn().mockReturnValue({
                                    eq: vi.fn().mockReturnValue({
                                        gte: vi.fn().mockResolvedValue({ count: 0, error: null }),
                                    }),
                                }),
                            }),
                        }),
                    };
                }
                return {};
            });

            const result = await sendThankYouWhatsApp(fakeFastify, {
                organizationId: 'org-123',
                contactId: 'contact-123',
                phoneE164: '+525512345678',
                whatsappTemplateName: null,
            });

            expect(result.sent).toBe(false);
            expect(result.skipReason).toBe('sin_plantilla_aprobada_fuera_de_ventana');
        });

        it('sin credenciales de WhatsApp (token ausente): retorna skipReason sin_credenciales_whatsapp', async () => {
            vi.spyOn(secretService, 'getSecret').mockResolvedValue(null);

            fakeFastify.supabaseAdmin.from.mockImplementation((table: string) => {
                if (table === 'organizations') {
                    return {
                        select: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                maybeSingle: vi.fn().mockResolvedValue({
                                    data: { whatsapp_phone_number_id: 'phone-id-123' },
                                    error: null,
                                }),
                            }),
                        }),
                    };
                }
                return {};
            });

            const result = await sendThankYouWhatsApp(fakeFastify, {
                organizationId: 'org-123',
                contactId: 'contact-123',
                phoneE164: '+525512345678',
            });

            expect(result.sent).toBe(false);
            expect(result.skipReason).toBe('sin_credenciales_whatsapp');
        });
    });
});
