import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { processThankYouForLead } from '../services/thank-you-service.js';

export const SEND_THANK_YOU_QUEUE = 'send-thank-you';

export interface SendThankYouJobData {
    leadId: string;
}

/**
 * Worker asíncrono para el despacho de agradecimiento omnicanal.
 * Invoca el servicio central que maneja la deduplicación atómica y resolución de canal.
 */
export async function sendThankYouHandler(
    fastify: FastifyInstance,
    job: Job<SendThankYouJobData>
): Promise<void> {
    const { leadId } = job.data;
    if (!leadId) {
        throw new Error('sendThankYouHandler invocado sin leadId');
    }

    await processThankYouForLead(fastify, leadId);
}

/**
 * Registra la cola y el worker de pg-boss para `send-thank-you`.
 */
export async function registerSendThankYouWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(SEND_THANK_YOU_QUEUE, {
        retryLimit: 5,
        retryBackoff: true,
    });

    await fastify.pgBoss.work<SendThankYouJobData>(SEND_THANK_YOU_QUEUE, async ([job]) => {
        await sendThankYouHandler(fastify, job);
    });
}
