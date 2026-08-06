import dotenv from 'dotenv';
import { buildApp } from './app.js';
import { validateEnv } from './config/env.js';
import { logger } from './lib/logger.js';

dotenv.config();

/**
 * Punto de entrada principal para iniciar el servidor Fastify con cierre elegante.
 */
async function startServer() {
    // 1.1 Validar variables de entorno antes de cualquier inicialización
    const env = validateEnv();

    const PORT = env.PORT;
    const HOST = env.HOST;

    const app = await buildApp();

    try {
        await app.listen({ port: PORT, host: HOST });
        app.log.info(`🚀 Servidor Fastify escuchando en http://${HOST}:${PORT}`);
        app.log.info(`👉 Endpoint de salud: http://localhost:${PORT}/health`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }

    /**
     * Cierre elegante (Graceful Shutdown) para liberar conexiones activas (SIGTERM / SIGINT).
     */
    let isShuttingDown = false;
    const shutdown = async (signal: string) => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        logger.info({ signal }, 'Iniciando cierre elegante del servidor...');
        try {
            await app.close();
            logger.info('Servidor Fastify y conexiones de pg-boss cerrados correctamente.');
            process.exit(0);
        } catch (shutdownErr) {
            logger.error({ err: shutdownErr }, 'Error durante el cierre del servidor');
            process.exit(1);
        }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer();