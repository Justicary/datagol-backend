import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { elevenLabsToolsRoutes } from '../src/routes/elevenlabs-tools.js';

/**
 * Regresión de un hallazgo de seguridad real (Fase 5): esta ruta legacy
 * resolvía `organization_id` leyendo `dynamic_variables` del cuerpo de la
 * petición y, si faltaba, caía por defecto a la organización real de
 * producción (`56422ca1-ec44-45b4-9eac-7e068d9169be`) — cualquier POST sin
 * ese campo operaba silenciosamente sobre datos de un cliente real
 * (AGENTS.md §5.1: prohibido leer/asumir `organization_id` del cuerpo).
 *
 * Esta prueba fija el contrato correcto: sin `dynamic_variables.organization_id`,
 * la petición se rechaza — nunca se asume una organización.
 */
async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(elevenLabsToolsRoutes);
    await app.ready();
    return app;
}

describe('POST /api/elevenlabs/tools — resolución de organización (ruta legacy)', () => {
    it('rechaza con 400 cuando dynamic_variables.organization_id está ausente, en vez de asumir una organización por defecto', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/elevenlabs/tools',
                payload: { tool_name: 'checkAvailability', parameters: {} },
            });
            expect(response.statusCode).toBe(400);
            const body = response.json();
            expect(body.status).toBe('error');
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: con dynamic_variables.organization_id explícito, la petición se procesa (no se rechaza por falta de organización)', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/api/elevenlabs/tools',
                payload: {
                    tool_name: 'herramienta_inexistente_de_prueba',
                    parameters: {},
                    dynamic_variables: { organization_id: '00000000-0000-0000-0000-000000000000' },
                },
            });
            // No debe ser el 400 de "organización no identificada": cualquier
            // otro código/resultado confirma que sí se aceptó organizationId.
            expect(response.statusCode).not.toBe(400);
        } finally {
            await app.close();
        }
    });
});
