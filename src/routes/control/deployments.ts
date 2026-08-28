import { FastifyPluginAsync } from 'fastify';
import { isPlatformAdmin } from '../../lib/platform-admin.js';
import {
    createDeployment,
    getDeployment,
    listDeployments,
    updateDeployment,
    changeDeploymentStatus,
    listProvisioningTasks,
    patchProvisioningTask,
    DeploymentServiceError,
} from '../../services/deployment-service.js';
import {
    upsertDeploymentBodySchema,
    patchDeploymentBodySchema,
    changeDeploymentStatusBodySchema,
    patchProvisioningTaskBodySchema,
} from '../../schemas/control/customer-schemas.js';

/** Fase C — registro comercial, exclusivo de api.datagol.net. */
export const controlDeploymentsRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', isPlatformAdmin);

    fastify.post('/control/deployments', async (request, reply) => {
        const parseResult = upsertDeploymentBodySchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: parseResult.error.issues[0]?.message, details: parseResult.error.issues });
        }

        try {
            const deployment = await createDeployment(fastify, parseResult.data, request.platformAdminUserId);
            return reply.status(201).send({ data: deployment });
        } catch (err) {
            return handleDeploymentError(err, reply);
        }
    });

    fastify.get('/control/deployments', async (_request, reply) => {
        try {
            const deployments = await listDeployments(fastify);
            return reply.status(200).send({ data: deployments });
        } catch (err) {
            return handleDeploymentError(err, reply);
        }
    });

    fastify.get<{ Params: { id: string } }>('/control/deployments/:id', async (request, reply) => {
        try {
            const deployment = await getDeployment(fastify, request.params.id);
            return reply.status(200).send({ data: deployment });
        } catch (err) {
            return handleDeploymentError(err, reply);
        }
    });

    fastify.patch<{ Params: { id: string } }>('/control/deployments/:id', async (request, reply) => {
        const parseResult = patchDeploymentBodySchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: parseResult.error.issues[0]?.message, details: parseResult.error.issues });
        }

        try {
            const deployment = await updateDeployment(fastify, request.params.id, parseResult.data);
            return reply.status(200).send({ data: deployment });
        } catch (err) {
            return handleDeploymentError(err, reply);
        }
    });

    fastify.post<{ Params: { id: string } }>('/control/deployments/:id/status', async (request, reply) => {
        const parseResult = changeDeploymentStatusBodySchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: parseResult.error.issues[0]?.message, details: parseResult.error.issues });
        }

        try {
            const deployment = await changeDeploymentStatus(
                fastify,
                request.params.id,
                parseResult.data.status,
                parseResult.data.reason,
                request.platformAdminUserId
            );
            return reply.status(200).send({ data: deployment });
        } catch (err) {
            return handleDeploymentError(err, reply);
        }
    });

    fastify.get<{ Params: { id: string } }>('/control/deployments/:id/tasks', async (request, reply) => {
        try {
            const tasks = await listProvisioningTasks(fastify, request.params.id);
            return reply.status(200).send({ data: tasks });
        } catch (err) {
            return handleDeploymentError(err, reply);
        }
    });

    fastify.patch<{ Params: { id: string; taskKey: string } }>('/control/deployments/:id/tasks/:taskKey', async (request, reply) => {
        const parseResult = patchProvisioningTaskBodySchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: parseResult.error.issues[0]?.message, details: parseResult.error.issues });
        }

        try {
            const task = await patchProvisioningTask(
                fastify,
                request.params.id,
                request.params.taskKey,
                parseResult.data,
                request.platformAdminUserId
            );
            return reply.status(200).send({ data: task });
        } catch (err) {
            return handleDeploymentError(err, reply);
        }
    });
};

function handleDeploymentError(err: unknown, reply: any) {
    if (err instanceof DeploymentServiceError) {
        return reply.status(err.statusCode).send({ error: err.name, message: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: 'InternalServerError', message });
}

export default controlDeploymentsRoutes;
