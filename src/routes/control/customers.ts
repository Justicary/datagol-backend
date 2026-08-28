import { FastifyPluginAsync } from 'fastify';
import { isPlatformAdmin } from '../../lib/platform-admin.js';
import { createCustomer, getCustomer, listCustomers, updateCustomer, CustomerServiceError } from '../../services/customer-service.js';
import { upsertCustomerBodySchema, patchCustomerBodySchema } from '../../schemas/control/customer-schemas.js';

/** Fase C — registro comercial, exclusivo de api.datagol.net. */
export const controlCustomersRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', isPlatformAdmin);

    fastify.post('/control/customers', async (request, reply) => {
        const parseResult = upsertCustomerBodySchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: parseResult.error.issues[0]?.message, details: parseResult.error.issues });
        }

        try {
            const customer = await createCustomer(fastify, parseResult.data);
            return reply.status(201).send({ data: customer });
        } catch (err) {
            return handleCustomerError(err, reply);
        }
    });

    fastify.get('/control/customers', async (_request, reply) => {
        try {
            const customers = await listCustomers(fastify);
            return reply.status(200).send({ data: customers });
        } catch (err) {
            return handleCustomerError(err, reply);
        }
    });

    fastify.get<{ Params: { id: string } }>('/control/customers/:id', async (request, reply) => {
        try {
            const customer = await getCustomer(fastify, request.params.id);
            return reply.status(200).send({ data: customer });
        } catch (err) {
            return handleCustomerError(err, reply);
        }
    });

    fastify.patch<{ Params: { id: string } }>('/control/customers/:id', async (request, reply) => {
        const parseResult = patchCustomerBodySchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: parseResult.error.issues[0]?.message, details: parseResult.error.issues });
        }

        try {
            const customer = await updateCustomer(fastify, request.params.id, parseResult.data);
            return reply.status(200).send({ data: customer });
        } catch (err) {
            return handleCustomerError(err, reply);
        }
    });
};

function handleCustomerError(err: unknown, reply: any) {
    if (err instanceof CustomerServiceError) {
        return reply.status(err.statusCode).send({ error: err.name, message: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: 'InternalServerError', message });
}

export default controlCustomersRoutes;
