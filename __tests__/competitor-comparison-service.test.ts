import { describe, it, expect, vi } from 'vitest';
import { compareSnapshots, getCompetitorAnalysisForReport } from '../src/services/competitor-comparison-service.js';

describe('services/competitor-comparison-service.ts', () => {
    describe('compareSnapshots', () => {
        it('primera semana (sin snapshot previo): isBaseline=true, sin comparación inventada', () => {
            const result = compareSnapshots(null, 'Servicio A\nServicio B\nPrecio $500');
            expect(result).toEqual({ isBaseline: true, addedLines: [], removedLines: [] });
        });

        it('contraparte de éxito: detecta líneas nuevas y líneas que desaparecieron', () => {
            const previous = 'Servicio A\nServicio B\nPrecio $500';
            const current = 'Servicio A\nServicio C\nPrecio $450';

            const result = compareSnapshots(previous, current);

            expect(result.isBaseline).toBe(false);
            expect(result.addedLines).toEqual(['Servicio C', 'Precio $450']);
            expect(result.removedLines).toEqual(['Servicio B', 'Precio $500']);
        });

        it('sin cambios reales: addedLines y removedLines vacíos', () => {
            const text = 'Servicio A\nServicio B';
            const result = compareSnapshots(text, text);
            expect(result.addedLines).toEqual([]);
            expect(result.removedLines).toEqual([]);
        });

        it('ignora mayúsculas/espacios al comparar, pero conserva el texto original al reportar', () => {
            const previous = 'servicio a';
            const current = '  Servicio A  ';
            const result = compareSnapshots(previous, current);
            expect(result.addedLines).toEqual([]);
            expect(result.removedLines).toEqual([]);
        });
    });

    describe('getCompetitorAnalysisForReport', () => {
        function buildFakeFastify(sites: any[], snapshotsBySiteAndWeek: Record<string, any>) {
            const fastify: any = {
                supabaseAdmin: {
                    from: vi.fn((table: string) => {
                        if (table === 'competitor_sites') {
                            return {
                                select: vi.fn().mockReturnValue({
                                    eq: vi.fn().mockReturnValue({
                                        eq: vi.fn().mockResolvedValue({ data: sites, error: null }),
                                    }),
                                }),
                            };
                        }
                        if (table === 'competitor_site_snapshots') {
                            return {
                                select: vi.fn().mockReturnValue({
                                    eq: vi.fn((_col: string, siteId: string) => ({
                                        eq: vi.fn((_col2: string, weekStart: string) => ({
                                            maybeSingle: vi.fn().mockResolvedValue({
                                                data: snapshotsBySiteAndWeek[`${siteId}:${weekStart}`] ?? null,
                                                error: null,
                                            }),
                                        })),
                                    })),
                                }),
                            };
                        }
                        return {};
                    }),
                },
            };
            return fastify;
        }

        it('sin sitios habilitados: devuelve null', async () => {
            const fastify = buildFakeFastify([], {});
            const result = await getCompetitorAnalysisForReport(fastify, 'org-1', '2026-08-10');
            expect(result).toBeNull();
        });

        it('sitio sin snapshot esta semana: se omite (no se inventa), y si no queda ninguno devuelve null', async () => {
            const fastify = buildFakeFastify([{ id: 'site-1', url: 'https://x.com', label: 'X' }], {});
            const result = await getCompetitorAnalysisForReport(fastify, 'org-1', '2026-08-10');
            expect(result).toBeNull();
        });

        it('contraparte de éxito: primera semana (baseline) para un sitio con snapshot ok', async () => {
            const fastify = buildFakeFastify(
                [{ id: 'site-1', url: 'https://x.com', label: 'X' }],
                {
                    'site-1:2026-08-10': { fetch_status: 'ok', extracted_text: 'Promoción de verano', error: null },
                    // sin snapshot de la semana anterior (2026-08-03) -> null
                }
            );

            const result = await getCompetitorAnalysisForReport(fastify, 'org-1', '2026-08-10');

            expect(result).not.toBeNull();
            expect(result?.approximate).toBe(true);
            expect(result?.sites[0]).toMatchObject({ siteId: 'site-1', status: 'ok', isBaseline: true });
        });

        it('sitio bloqueado por robots.txt: se reporta el error, no se omite en silencio (C.4)', async () => {
            const fastify = buildFakeFastify(
                [{ id: 'site-1', url: 'https://x.com', label: 'X' }],
                {
                    'site-1:2026-08-10': { fetch_status: 'blocked_by_robots', extracted_text: null, error: 'robots.txt prohíbe esta ruta' },
                }
            );

            const result = await getCompetitorAnalysisForReport(fastify, 'org-1', '2026-08-10');

            expect(result?.sites[0]).toMatchObject({ status: 'blocked_by_robots', isBaseline: false });
        });

        it('semana subsecuente: compara contra la semana anterior', async () => {
            const fastify = buildFakeFastify(
                [{ id: 'site-1', url: 'https://x.com', label: 'X' }],
                {
                    'site-1:2026-08-10': { fetch_status: 'ok', extracted_text: 'Servicio A\nPrecio $450', error: null },
                    'site-1:2026-08-03': { fetch_status: 'ok', extracted_text: 'Servicio A\nPrecio $500', error: null },
                }
            );

            const result = await getCompetitorAnalysisForReport(fastify, 'org-1', '2026-08-10');

            expect(result?.sites[0].isBaseline).toBe(false);
            expect(result?.sites[0].addedLines).toEqual(['Precio $450']);
            expect(result?.sites[0].removedLines).toEqual(['Precio $500']);
        });
    });
});
