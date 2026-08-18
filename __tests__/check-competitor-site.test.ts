import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkCompetitorSiteHandler } from '../src/jobs/check-competitor-site.js';
import * as entitlementsService from '../src/services/entitlements.js';
import * as scraperService from '../src/services/competitor-scraper-service.js';

function buildFakeFastify() {
    const inserted: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];

    const fastify: any = {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        supabaseAdmin: {
            from: vi.fn((table: string) => {
                if (table === 'competitor_site_snapshots') {
                    return {
                        insert: vi.fn().mockImplementation((row: Record<string, unknown>) => {
                            inserted.push(row);
                            return Promise.resolve({ error: null });
                        }),
                    };
                }
                if (table === 'competitor_sites') {
                    return {
                        update: vi.fn((row: Record<string, unknown>) => ({
                            eq: vi.fn().mockImplementation(() => {
                                updated.push(row);
                                return Promise.resolve({ error: null });
                            }),
                        })),
                    };
                }
                return {};
            }),
        },
    };

    return { fastify, inserted, updated };
}

function fakeJob(data: any) {
    return { data } as any;
}

describe('jobs/check-competitor-site.ts', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('feature no habilitada: no scrapea ni guarda nada', async () => {
        vi.spyOn(entitlementsService, 'getOrganizationFeatures').mockResolvedValue(new Set());
        const scraperSpy = vi.spyOn(scraperService, 'checkCompetitorSite');
        const { fastify, inserted } = buildFakeFastify();

        await checkCompetitorSiteHandler(
            fastify,
            fakeJob({ competitorSiteId: 'site-1', organizationId: 'org-1', url: 'https://x.com', weekStart: '2026-08-10' })
        );

        expect(scraperSpy).not.toHaveBeenCalled();
        expect(inserted).toHaveLength(0);
    });

    it('contraparte de éxito: guarda el snapshot y actualiza last_checked_at/last_error', async () => {
        vi.spyOn(entitlementsService, 'getOrganizationFeatures').mockResolvedValue(new Set(['competitor_analysis']));
        vi.spyOn(scraperService, 'checkCompetitorSite').mockResolvedValue({ status: 'ok', text: 'Promoción de verano' });
        const { fastify, inserted, updated } = buildFakeFastify();

        await checkCompetitorSiteHandler(
            fastify,
            fakeJob({ competitorSiteId: 'site-1', organizationId: 'org-1', url: 'https://x.com', weekStart: '2026-08-10' })
        );

        expect(inserted).toHaveLength(1);
        expect(inserted[0]).toMatchObject({ fetch_status: 'ok', extracted_text: 'Promoción de verano', week_start: '2026-08-10' });
        expect(updated).toHaveLength(1);
        expect(updated[0]).toMatchObject({ last_error: null });
    });

    it('sitio bloqueado por robots: guarda el snapshot con el error, sin lanzar', async () => {
        vi.spyOn(entitlementsService, 'getOrganizationFeatures').mockResolvedValue(new Set(['competitor_analysis']));
        vi.spyOn(scraperService, 'checkCompetitorSite').mockResolvedValue({
            status: 'blocked_by_robots',
            error: 'robots.txt prohíbe esta ruta',
        });
        const { fastify, inserted, updated } = buildFakeFastify();

        await checkCompetitorSiteHandler(
            fastify,
            fakeJob({ competitorSiteId: 'site-1', organizationId: 'org-1', url: 'https://x.com', weekStart: '2026-08-10' })
        );

        expect(inserted[0]).toMatchObject({ fetch_status: 'blocked_by_robots' });
        expect(updated[0]).toMatchObject({ last_error: 'robots.txt prohíbe esta ruta' });
    });

    it('idempotencia: un snapshot duplicado (23505) no lanza, solo se omite', async () => {
        vi.spyOn(entitlementsService, 'getOrganizationFeatures').mockResolvedValue(new Set(['competitor_analysis']));
        vi.spyOn(scraperService, 'checkCompetitorSite').mockResolvedValue({ status: 'ok', text: 'x' });

        const fastify: any = {
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            supabaseAdmin: {
                from: vi.fn(() => ({
                    insert: vi.fn().mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } }),
                    update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
                })),
            },
        };

        await expect(
            checkCompetitorSiteHandler(
                fastify,
                fakeJob({ competitorSiteId: 'site-1', organizationId: 'org-1', url: 'https://x.com', weekStart: '2026-08-10' })
            )
        ).resolves.not.toThrow();
    });
});
