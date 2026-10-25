import { FastifyInstance } from 'fastify';
import { type AskReportResponse } from '../../types/natural-reports.js';
import {
    askHarness,
    checkRateLimits,
    clearReportCaches,
    NaturalReportsError,
} from '../harness/ask-harness.js';

export { checkRateLimits, clearReportCaches, NaturalReportsError };

export interface AskReportOptions {
    question: string;
    userId: string;
    now?: Date;
}

/**
 * Envoltorio del canal Dashboard sobre el arnés central (`askHarness`).
 * Mantiene intacto el contrato público para `routes/organization-reports.ts`
 * y las pruebas existentes.
 */
export async function askReport(
    fastify: FastifyInstance,
    organizationId: string,
    options: AskReportOptions
): Promise<AskReportResponse> {
    return askHarness(fastify, organizationId, {
        channel: 'dashboard',
        actorKey: options.userId,
        question: options.question,
        now: options.now,
    });
}
