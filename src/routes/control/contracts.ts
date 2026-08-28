import { FastifyPluginAsync } from 'fastify';
import { isPlatformAdmin } from '../../lib/platform-admin.js';
import { generateContract, getContractSignedPdfUrl, signContract, ContractServiceError } from '../../services/contract-service.js';
import { generateAndSendContractOtp, ContractOtpError } from '../../services/contract-otp-service.js';
import { generateContractBodySchema, signContractBodySchema } from '../../schemas/control/contract-schemas.js';

/** Fase D — contrato y firma, exclusivo de api.datagol.net. */
export const controlContractsRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', isPlatformAdmin);

    fastify.post<{ Params: { id: string } }>('/control/deployments/:id/contract', async (request, reply) => {
        const parseResult = generateContractBodySchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: parseResult.error.issues[0]?.message, details: parseResult.error.issues });
        }

        try {
            const contract = await generateContract(fastify, {
                deploymentId: request.params.id,
                templateVersion: parseResult.data.templateVersion,
                signerName: parseResult.data.signerName,
                signerRole: parseResult.data.signerRole,
                signerEmail: parseResult.data.signerEmail,
                signerPhoneE164: parseResult.data.signerPhoneE164,
            });
            return reply.status(201).send({ data: contract });
        } catch (err) {
            return handleContractError(err, reply);
        }
    });

    fastify.post<{ Params: { id: string } }>('/control/contracts/:id/send-otp', async (request, reply) => {
        try {
            await generateAndSendContractOtp(fastify, request.params.id);
            return reply.status(200).send({ message: 'Código de verificación enviado.' });
        } catch (err) {
            return handleContractError(err, reply);
        }
    });

    fastify.post<{ Params: { id: string } }>('/control/contracts/:id/sign', async (request, reply) => {
        const parseResult = signContractBodySchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: parseResult.error.issues[0]?.message, details: parseResult.error.issues });
        }

        const result = await signContract(
            fastify,
            request.params.id,
            parseResult.data.code,
            parseResult.data.signerIp ?? request.ip ?? null,
            parseResult.data.signerUserAgent ?? (request.headers['user-agent'] as string | undefined) ?? null
        );

        if (!result.success) {
            return reply.status(400).send({ error: 'SignatureRejected', message: result.reason });
        }

        return reply.status(200).send({ data: result.contract });
    });

    fastify.get<{ Params: { id: string } }>('/control/contracts/:id/pdf', async (request, reply) => {
        try {
            const url = await getContractSignedPdfUrl(fastify, request.params.id);
            return reply.status(200).send({ data: { url } });
        } catch (err) {
            return handleContractError(err, reply);
        }
    });
};

function handleContractError(err: unknown, reply: any) {
    if (err instanceof ContractServiceError || err instanceof ContractOtpError) {
        return reply.status(err.statusCode).send({ error: err.name, message: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: 'InternalServerError', message });
}

export default controlContractsRoutes;
