import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/entitlements.js', () => ({
    getOrganizationFeatures: vi.fn().mockResolvedValue(new Set(['automatic_thank_you', 'whatsapp'])),
}));

import { getOrganizationFeatures } from '../src/services/entitlements.js';
import { resolveThankYouChannel, processThankYouForLead } from '../src/services/thank-you-service.js';
import { THANK_YOU_CHANNELS, THANK_YOU_STATUSES, THANK_YOU_SKIP_REASONS } from '../src/types/thank-you.js';
import { LEAD_CHANNELS } from '../src/types/lead-enums.js';
import { FEATURE_KEYS } from '../src/types/feature-taxonomy.js';
import type { FastifyInstance } from 'fastify';

describe('Agradecimiento Automático — Matriz de Decisión y Elegibilidad', () => {
    describe('resolveThankYouChannel (Matriz Pura)', () => {
        it('cuando hay adjunto configurado y hay correo disponible, el canal SIEMPRE es Correo', () => {
            // Incluso si el lead proviene de WhatsApp
            const channelFromWA = resolveThankYouChannel({
                hasActiveAttachment: true,
                hasEmail: true,
                hasPhone: true,
                originChannel: LEAD_CHANNELS.WHATSAPP,
            });
            expect(channelFromWA).toBe(THANK_YOU_CHANNELS.EMAIL);

            // Lead de voz con adjunto y correo
            const channelFromVoice = resolveThankYouChannel({
                hasActiveAttachment: true,
                hasEmail: true,
                hasPhone: true,
                originChannel: LEAD_CHANNELS.VOICE,
            });
            expect(channelFromVoice).toBe(THANK_YOU_CHANNELS.EMAIL);
        });

        it('cuando NO hay adjunto y el prospecto llegó por WhatsApp, el canal es WhatsApp', () => {
            const channel = resolveThankYouChannel({
                hasActiveAttachment: false,
                hasEmail: true,
                hasPhone: true,
                originChannel: LEAD_CHANNELS.WHATSAPP,
            });
            expect(channel).toBe(THANK_YOU_CHANNELS.WHATSAPP);
        });

        it('cuando NO hay adjunto, llegó por voz o web, y hay correo, el canal es Correo', () => {
            const channelVoice = resolveThankYouChannel({
                hasActiveAttachment: false,
                hasEmail: true,
                hasPhone: true,
                originChannel: LEAD_CHANNELS.VOICE,
            });
            expect(channelVoice).toBe(THANK_YOU_CHANNELS.EMAIL);

            const channelWeb = resolveThankYouChannel({
                hasActiveAttachment: false,
                hasEmail: true,
                hasPhone: true,
                originChannel: LEAD_CHANNELS.WEB,
            });
            expect(channelWeb).toBe(THANK_YOU_CHANNELS.EMAIL);
        });

        it('cuando SOLO hay teléfono disponible (sin correo), el canal es WhatsApp si está habilitado', () => {
            const channelWithWA = resolveThankYouChannel({
                hasActiveAttachment: false,
                hasEmail: false,
                hasPhone: true,
                isWhatsAppEntitled: true,
            });
            expect(channelWithWA).toBe(THANK_YOU_CHANNELS.WHATSAPP);

            const channelWithoutWA = resolveThankYouChannel({
                hasActiveAttachment: false,
                hasEmail: false,
                hasPhone: true,
                isWhatsAppEntitled: false,
            });
            expect(channelWithoutWA).toBeNull();
        });

        it('cuando hay ambos canales y ninguna condición especial aplica, el canal es Correo', () => {
            const channel = resolveThankYouChannel({
                hasActiveAttachment: false,
                hasEmail: true,
                hasPhone: true,
                originChannel: 'desconocido',
            });
            expect(channel).toBe(THANK_YOU_CHANNELS.EMAIL);
        });

        it('cuando no hay ni correo ni teléfono, retorna null', () => {
            const channel = resolveThankYouChannel({
                hasActiveAttachment: false,
                hasEmail: false,
                hasPhone: false,
            });
            expect(channel).toBeNull();
        });
    });

    describe('processThankYouForLead (Reglas de exclusión y omisión)', () => {
        let fakeFastify: any;
        let mockInsert: any;
        let mockRpc: any;

        beforeEach(() => {
            vi.mocked(getOrganizationFeatures).mockResolvedValue(
                new Set([FEATURE_KEYS.AUTOMATIC_THANK_YOU, FEATURE_KEYS.WHATSAPP])
            );
            mockInsert = vi.fn().mockResolvedValue({ error: null });
            mockRpc = vi.fn().mockResolvedValue({
                data: { allowed: true, send_id: 'send-123', skip_reason: null },
                error: null,
            });

            fakeFastify = {
                supabaseAdmin: {
                    from: vi.fn(),
                    rpc: mockRpc,
                },
                log: {
                    info: vi.fn(),
                    warn: vi.fn(),
                    error: vi.fn(),
                },
            };
        });

        it('omite el envío cuando contacts.opted_out es true y registra skip_reason contacto_opted_out', async () => {
            const mockLead = {
                id: 'lead-optout',
                organization_id: 'org-123',
                contact_id: 'contact-optout',
                channel: 'voice',
                email: 'test@example.com',
                contacts: {
                    id: 'contact-optout',
                    email: 'test@example.com',
                    phone_e164: '+525511223344',
                    opted_out: true,
                },
                organizations: {
                    id: 'org-123',
                    name: 'Test Org',
                    integration_settings: { thankYou: { enabled: true } },
                },
            };

            (fakeFastify.supabaseAdmin.from as any).mockImplementation((table: string) => {
                if (table === 'leads') {
                    return {
                        select: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                single: vi.fn().mockResolvedValue({ data: mockLead, error: null }),
                            }),
                        }),
                    };
                }
                if (table === 'thank_you_sends') {
                    return { insert: mockInsert };
                }
                return {};
            });

            await processThankYouForLead(fakeFastify, 'lead-optout');

            expect(mockInsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: THANK_YOU_STATUSES.OMITIDO,
                    skip_reason: THANK_YOU_SKIP_REASONS.OPTED_OUT,
                })
            );
        });

        it('omite el envío cuando el prospecto no dejó ni correo ni teléfono (sin_datos_de_contacto)', async () => {
            const mockLead = {
                id: 'lead-nodata',
                organization_id: 'org-123',
                contact_id: 'contact-nodata',
                channel: 'web',
                email: null,
                contact_phone: null,
                contacts: {
                    id: 'contact-nodata',
                    email: null,
                    phone_e164: null,
                    opted_out: false,
                },
                organizations: {
                    id: 'org-123',
                    name: 'Test Org',
                    integration_settings: { thankYou: { enabled: true } },
                },
            };

            (fakeFastify.supabaseAdmin.from as any).mockImplementation((table: string) => {
                if (table === 'leads') {
                    return {
                        select: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                single: vi.fn().mockResolvedValue({ data: mockLead, error: null }),
                            }),
                        }),
                    };
                }
                if (table === 'thank_you_sends') {
                    return { insert: mockInsert };
                }
                return {};
            });

            await processThankYouForLead(fakeFastify, 'lead-nodata');

            expect(mockInsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: THANK_YOU_STATUSES.OMITIDO,
                    skip_reason: THANK_YOU_SKIP_REASONS.NO_CONTACT_INFO,
                })
            );
        });

        it('omite el envío cuando thankYou.enabled es false (agradecimiento_desactivado)', async () => {
            const mockLead = {
                id: 'lead-disabled',
                organization_id: 'org-123',
                contact_id: 'contact-disabled',
                channel: 'voice',
                email: 'test@example.com',
                contacts: {
                    id: 'contact-disabled',
                    email: 'test@example.com',
                    phone_e164: '+525511223344',
                    opted_out: false,
                },
                organizations: {
                    id: 'org-123',
                    name: 'Test Org',
                    integration_settings: { thankYou: { enabled: false } },
                },
            };

            (fakeFastify.supabaseAdmin.from as any).mockImplementation((table: string) => {
                if (table === 'leads') {
                    return {
                        select: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                single: vi.fn().mockResolvedValue({ data: mockLead, error: null }),
                            }),
                        }),
                    };
                }
                if (table === 'thank_you_sends') {
                    return { insert: mockInsert };
                }
                if (table === 'features') {
                    return {
                        select: vi.fn().mockResolvedValue({ data: [] }),
                    };
                }
                return {};
            });

            // Simulamos feature concedida en RPC
            (fakeFastify.supabaseAdmin.rpc as any).mockImplementation((fn: string) => {
                if (fn === 'organization_enabled_features') {
                    return Promise.resolve({ data: [FEATURE_KEYS.AUTOMATIC_THANK_YOU, FEATURE_KEYS.WHATSAPP], error: null });
                }
                return Promise.resolve({ data: {}, error: null });
            });

            await processThankYouForLead(fakeFastify, 'lead-disabled');

            expect(mockInsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: THANK_YOU_STATUSES.OMITIDO,
                    skip_reason: THANK_YOU_SKIP_REASONS.SETTINGS_DISABLED,
                })
            );
        });
    });
});
