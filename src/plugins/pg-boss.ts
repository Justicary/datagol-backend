import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { PgBoss } from 'pg-boss';
import { validateEnv } from '../config/env.js';
import { parseDatabaseUrl } from '../lib/database-url.js';

/**
 * Plugin de Fastify para inicializar y gestionar el ciclo de vida de pg-boss sobre PostgreSQL.
 */
const pgBossPluginCallback: FastifyPluginAsync = async (fastify) => {
    const env = validateEnv();

    // Campos discretos (no `connectionString`): DATABASE_URL puede traer una
    // contraseña con caracteres especiales sin escapar que rompen el parseo
    // de `new URL()` que hacen `pg`/`pg-boss` internamente.
    const dbConfig = parseDatabaseUrl(env.DATABASE_URL);

    const boss = new PgBoss({
        ...dbConfig,
        schema: 'pgboss',
    });

    boss.on('error', (error: any) => {
        fastify.log.error({ err: error }, '[pg-boss] Error en el gestor de colas');
    });

    try {
        await boss.start();
        fastify.log.info('⚡ pg-boss iniciado con éxito en el esquema "pgboss"');
        fastify.decorate('pgBoss', boss);
    } catch (err: any) {
        fastify.log.error({ err }, '❌ Error al iniciar pg-boss');
        throw err;
    }

    fastify.addHook('onClose', async () => {
        fastify.log.info('🛑 Cerrando cola de trabajos pg-boss...');
        try {
            await boss.stop();
            fastify.log.info('✅ pg-boss detenido de forma elegante.');
        } catch (stopErr: any) {
            fastify.log.error({ err: stopErr }, '❌ Error al detener pg-boss');
        }
    });
};

export const pgBossPlugin = fp(pgBossPluginCallback, {
    name: 'pg-boss-plugin',
});

export default pgBossPlugin;
