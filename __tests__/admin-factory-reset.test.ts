import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import adminFactoryResetRoutes from '../src/routes/admin/factory-reset.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import * as factoryResetService from '../src/services/factory-reset-service.js';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(adminFactoryResetRoutes);
    await app.ready();
    return app;
}

/**
 * A propósito, esta suite NUNCA ejecuta la función SQL real:
 * `factory_reset_transactional_data()` no tiene filtro por organización y
 * vaciaría datos REALES de la base compartida en cada corrida. Aquí se
 * cubren auth, validación y la orquestación de la ruta con la RPC simulada.
 * La función en sí se prueba en __tests__/factory-reset-function.test.ts,
 * dentro de una transacción con ROLLBACK (nunca persiste).
 */
describe('POST /api/admin/factory-reset', () => {
    it('rechaza sin autenticación de plataforma', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/admin/factory-reset',
                payload: { confirmation: 'REINICIAR TODO', reason: 'prueba' },
            });
            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('400 sin "reason"', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/admin/factory-reset',
                headers: { 'x-platform-admin': 'true' },
                payload: { confirmation: 'REINICIAR TODO' },
            });
            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('400 con "reason" en blanco', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/admin/factory-reset',
                headers: { 'x-platform-admin': 'true' },
                payload: { confirmation: 'REINICIAR TODO', reason: '   ' },
            });
            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('400 sin la frase de confirmación exacta', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/admin/factory-reset',
                headers: { 'x-platform-admin': 'true' },
                payload: { confirmation: 'reiniciar todo', reason: 'prueba' },
            });
            expect(response.statusCode).toBe(400);
            expect(response.json().message).toContain('REINICIAR TODO');
        } finally {
            await app.close();
        }
    });

    it('400 con la frase de confirmación vacía', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/admin/factory-reset',
                headers: { 'x-platform-admin': 'true' },
                payload: { reason: 'prueba' },
            });
            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    describe('orquestación (RPC simulada: no borra nada real)', () => {
        const VALID = { confirmation: 'REINICIAR TODO', reason: 'reinicio de pruebas' };
        const DELETED = { contacts_deleted: 3, weekly_reports_deleted: 2 };

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('lee rutas de reportes → ejecuta la función → borra archivos, y responde los conteos', async () => {
            const order: string[] = [];
            vi.spyOn(factoryResetService, 'collectReportStoragePaths').mockImplementation(async () => {
                order.push('collect');
                return ['org/ejecutivo/2026-09-14.html'];
            });
            const rpcSpy = vi.spyOn(supabaseAdmin, 'rpc').mockImplementation((async () => {
                order.push('rpc');
                return { data: DELETED, error: null };
            }) as never);
            const removeSpy = vi.spyOn(factoryResetService, 'removeReportFiles').mockImplementation(async () => {
                order.push('remove');
                return { removed: 1, failed: 0, errors: [] };
            });

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/admin/factory-reset',
                    headers: { 'x-platform-admin': 'true' },
                    payload: VALID,
                });

                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({
                    message: 'Restauración de valores de fábrica completada.',
                    deleted: DELETED,
                    storage: { reportFilesRemoved: 1, reportFilesFailed: 0 },
                });
                expect(order).toEqual(['collect', 'rpc', 'remove']);
                expect(rpcSpy).toHaveBeenCalledWith('factory_reset_transactional_data');
                expect(removeSpy).toHaveBeenCalledWith(supabaseAdmin, ['org/ejecutivo/2026-09-14.html']);
            } finally {
                await app.close();
            }
        });

        it('archivos que no se pudieron borrar se reportan en la respuesta (las filas ya se borraron)', async () => {
            vi.spyOn(factoryResetService, 'collectReportStoragePaths').mockResolvedValue(['a', 'b']);
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({ data: DELETED, error: null } as never);
            vi.spyOn(factoryResetService, 'removeReportFiles').mockResolvedValue({ removed: 0, failed: 2, errors: ['x'] });

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/admin/factory-reset',
                    headers: { 'x-platform-admin': 'true' },
                    payload: VALID,
                });
                expect(response.statusCode).toBe(200);
                expect(response.json().storage).toEqual({ reportFilesRemoved: 0, reportFilesFailed: 2 });
            } finally {
                await app.close();
            }
        });

        it('si no se pueden leer las rutas de reportes → 500 y NO se ejecuta la función', async () => {
            vi.spyOn(factoryResetService, 'collectReportStoragePaths').mockRejectedValue(new Error('lectura falló'));
            const rpcSpy = vi.spyOn(supabaseAdmin, 'rpc');
            const removeSpy = vi.spyOn(factoryResetService, 'removeReportFiles');

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/admin/factory-reset',
                    headers: { 'x-platform-admin': 'true' },
                    payload: VALID,
                });
                expect(response.statusCode).toBe(500);
                expect(response.json().message).toBe('No se pudieron leer los archivos de reportes; no se borró nada.');
                expect(rpcSpy).not.toHaveBeenCalled();
                expect(removeSpy).not.toHaveBeenCalled();
            } finally {
                await app.close();
            }
        });

        it('si la función falla → 500 y NO se borran archivos de Storage', async () => {
            vi.spyOn(factoryResetService, 'collectReportStoragePaths').mockResolvedValue(['a']);
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({ data: null, error: { message: 'fallo sql' } } as never);
            const removeSpy = vi.spyOn(factoryResetService, 'removeReportFiles');

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: '/api/admin/factory-reset',
                    headers: { 'x-platform-admin': 'true' },
                    payload: VALID,
                });
                expect(response.statusCode).toBe(500);
                expect(response.json().message).toBe('fallo sql');
                expect(removeSpy).not.toHaveBeenCalled();
            } finally {
                await app.close();
            }
        });
    });
});
