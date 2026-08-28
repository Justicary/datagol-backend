import { FastifyPluginAsync } from 'fastify';
import { controlLicensesRoutes } from './licenses.js';
import { controlCustomersRoutes } from './customers.js';
import { controlDeploymentsRoutes } from './deployments.js';
import { controlFleetRoutes } from './fleet.js';
import { controlContractsRoutes } from './contracts.js';
import { controlHeartbeatRoutes } from './heartbeat.js';
import { controlAdminPassportRoutes } from './admin-passport.js';

/**
 * Fase F — punto único de registro de todo `/control/**`. `src/app.ts` solo
 * llama a `app.register(controlPlaneRoutes)` cuando `CONTROL_PLANE=true`;
 * con la bandera apagada el módulo se importa (no tiene efectos de
 * arranque) pero jamás se registra, así que Fastify nunca crea estos
 * handlers y cualquier petición a `/control/**` cae en el 404 por defecto.
 */
export const controlPlaneRoutes: FastifyPluginAsync = async (fastify) => {
    await fastify.register(controlLicensesRoutes);
    await fastify.register(controlCustomersRoutes);
    await fastify.register(controlDeploymentsRoutes);
    await fastify.register(controlFleetRoutes);
    await fastify.register(controlContractsRoutes);
    await fastify.register(controlHeartbeatRoutes);
    await fastify.register(controlAdminPassportRoutes);
};

export default controlPlaneRoutes;
