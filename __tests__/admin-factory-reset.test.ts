import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import adminFactoryResetRoutes from '../src/routes/admin/factory-reset.js';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(adminFactoryResetRoutes);
    await app.ready();
    return app;
}

/**
 * A propósito, esta suite SOLO cubre auth y validación — nunca el camino
 * 200 de éxito. `factory_reset_transactional_data()` no tiene `WHERE`: un
 * test que de verdad lo ejecutara borraría appointments/call_logs/contacts/
 * feature_audit_log/leads REALES de producción en cada corrida de CI, no
 * datos de prueba aislados (a diferencia del resto de la suite, que crea y
 * borra sus propios fixtures). La función SÍ se verificó manualmente contra
 * la base real, dentro de una transacción con ROLLBACK (nunca persistida):
 * confirmó que las 5 tablas quedan en 0, que `usage_events` conserva sus
 * filas y `amount_usd` intactos (solo se limpia `call_log_id` colgante), y
 * que tras el ROLLBACK los conteos originales no cambiaron.
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
});
