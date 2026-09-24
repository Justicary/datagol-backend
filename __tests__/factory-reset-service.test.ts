import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
    collectReportStoragePaths,
    removeReportFiles,
    REPORT_PATHS_PAGE_SIZE,
    STORAGE_REMOVE_BATCH_SIZE,
} from '../src/services/factory-reset-service.js';

function fakeReportsTable(pages: Array<{ data: Array<{ storage_path: string }> | null; error: { message: string } | null }>) {
    const calls: Array<{ select: string; not: unknown[]; order: string; range: [number, number] }> = [];
    let page = 0;
    const client = {
        from: vi.fn((table: string) => {
            expect(table).toBe('weekly_reports');
            const call = { select: '', not: [] as unknown[], order: '', range: [0, 0] as [number, number] };
            calls.push(call);
            const builder = {
                select(cols: string) {
                    call.select = cols;
                    return builder;
                },
                not(...args: unknown[]) {
                    call.not = args;
                    return builder;
                },
                order(col: string) {
                    call.order = col;
                    return builder;
                },
                range(from: number, to: number) {
                    call.range = [from, to];
                    return builder;
                },
                async returns() {
                    return pages[page++];
                },
            };
            return builder;
        }),
    };
    return { supabase: client as unknown as SupabaseClient, calls };
}

function fakeStorage(results: Array<{ data: unknown[] | null; error: { message: string } | null } | Error>) {
    const batches: string[][] = [];
    const buckets: string[] = [];
    let i = 0;
    const client = {
        storage: {
            from: vi.fn((bucket: string) => {
                buckets.push(bucket);
                return {
                    remove: vi.fn(async (paths: string[]) => {
                        batches.push(paths);
                        const result = results[i++];
                        if (result instanceof Error) throw result;
                        return result;
                    }),
                };
            }),
        },
    };
    return { supabase: client as unknown as SupabaseClient, batches, buckets };
}

const paths = (n: number, prefix = 'p') => Array.from({ length: n }, (_, k) => `${prefix}${k}`);

describe('services/factory-reset-service.ts', () => {
    describe('collectReportStoragePaths', () => {
        it('lee solo filas con storage_path, ordenadas, en páginas hasta la última incompleta', async () => {
            const full = paths(REPORT_PATHS_PAGE_SIZE, 'a').map((storage_path) => ({ storage_path }));
            const { supabase, calls } = fakeReportsTable([
                { data: full, error: null },
                { data: [{ storage_path: 'b0' }, { storage_path: 'b1' }], error: null },
            ]);

            const result = await collectReportStoragePaths(supabase);

            expect(REPORT_PATHS_PAGE_SIZE).toBe(1000);
            expect(result).toHaveLength(REPORT_PATHS_PAGE_SIZE + 2);
            expect(result.slice(-2)).toEqual(['b0', 'b1']);
            expect(calls).toEqual([
                { select: 'storage_path', not: ['storage_path', 'is', null], order: 'id', range: [0, 999] },
                { select: 'storage_path', not: ['storage_path', 'is', null], order: 'id', range: [1000, 1999] },
            ]);
        });

        it('sin reportes → lista vacía con una sola consulta', async () => {
            const { supabase, calls } = fakeReportsTable([{ data: null, error: null }]);
            expect(await collectReportStoragePaths(supabase)).toEqual([]);
            expect(calls).toHaveLength(1);
        });

        it('error de lectura → lanza (sin la lista no se debe borrar nada)', async () => {
            const { supabase } = fakeReportsTable([{ data: null, error: { message: 'boom' } }]);
            await expect(collectReportStoragePaths(supabase)).rejects.toThrow('No se pudieron leer las rutas de weekly_reports: boom');
        });
    });

    describe('removeReportFiles', () => {
        it('borra en lotes de 100 del bucket organization-reports y cuenta lo que Storage confirma', async () => {
            const input = paths(STORAGE_REMOVE_BATCH_SIZE + 1);
            const { supabase, batches, buckets } = fakeStorage([
                { data: new Array(STORAGE_REMOVE_BATCH_SIZE).fill({}), error: null },
                { data: [], error: null }, // ya no existía: no es fallo
            ]);

            const result = await removeReportFiles(supabase, input);

            expect(STORAGE_REMOVE_BATCH_SIZE).toBe(100);
            expect(batches).toEqual([input.slice(0, 100), input.slice(100)]);
            expect(buckets).toEqual(['organization-reports', 'organization-reports']);
            expect(result).toEqual({ removed: 100, failed: 0, errors: [] });
        });

        it('sin rutas no llama a Storage', async () => {
            const { supabase, batches } = fakeStorage([]);
            expect(await removeReportFiles(supabase, [])).toEqual({ removed: 0, failed: 0, errors: [] });
            expect(batches).toEqual([]);
        });

        it('un lote con error o excepción se cuenta como fallido y los demás siguen', async () => {
            const input = paths(STORAGE_REMOVE_BATCH_SIZE * 2 + 1);
            const { supabase } = fakeStorage([
                { data: null, error: { message: 'storage caído' } },
                new Error('red'),
                { data: [{}], error: null },
            ]);

            expect(await removeReportFiles(supabase, input)).toEqual({ removed: 1, failed: 200, errors: ['storage caído', 'red'] });
        });

        it('una excepción que no es Error también se registra', async () => {
            const { supabase } = fakeStorage([]);
            vi.mocked(supabase.storage.from).mockReturnValue({
                remove: vi.fn().mockRejectedValue('texto'),
            } as never);
            expect(await removeReportFiles(supabase, ['x'])).toEqual({ removed: 0, failed: 1, errors: ['texto'] });
        });
    });
});
