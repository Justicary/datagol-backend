import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { evaluateWaitlistForSlot } from '../services/waitlist-engine.js';

export const EVALUATE_WAITLIST_FOR_SLOT_QUEUE = 'evaluate-waitlist-for-slot';

export interface EvaluateWaitlistForSlotJobData {
    organizationId: string;
    slotStartTime: string;
    slotEndTime: string;
}

/**
 * Encolado al cancelarse una cita (dashboard: `contacts-crm.ts`; voz:
 * `routes/tools/cancel.ts`) — docs/tasks/waitlist_confirmacion_masiva.md,
 * Tarea B3. Todo el trabajo real (matchmaking, envío de WhatsApp/voz) vive
 * en `waitlist-engine.ts`; este handler solo desempaqueta el job.
 */
export async function evaluateWaitlistForSlotHandler(
    fastify: FastifyInstance,
    job: Job<EvaluateWaitlistForSlotJobData>
): Promise<void> {
    const { organizationId, slotStartTime, slotEndTime } = job.data;
    await evaluateWaitlistForSlot(fastify, organizationId, { startTime: slotStartTime, endTime: slotEndTime });
}

export async function registerEvaluateWaitlistForSlotWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(EVALUATE_WAITLIST_FOR_SLOT_QUEUE, {
        retryLimit: 3,
        retryBackoff: true,
    });

    await fastify.pgBoss.work<EvaluateWaitlistForSlotJobData>(EVALUATE_WAITLIST_FOR_SLOT_QUEUE, async ([job]) => {
        await evaluateWaitlistForSlotHandler(fastify, job);
    });
}
