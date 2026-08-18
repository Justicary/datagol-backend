import { FastifyInstance } from 'fastify';
import {
    type NlIntentKey,
    type ResolvedPeriod,
    type IntentExecutionResult,
} from '../../types/natural-reports.js';
import { getIntentByKey } from './intents/index.js';

const STATEMENT_TIMEOUT_MS = 5000;

export interface ExecuteIntentOptions {
    intent: NlIntentKey;
    parameters: Record<string, unknown>;
    period: ResolvedPeriod;
}

export async function executeIntent(
    fastify: FastifyInstance,
    organizationId: string,
    options: ExecuteIntentOptions
): Promise<IntentExecutionResult> {
    const intentDef = getIntentByKey(options.intent);
    if (!intentDef) {
        throw new Error(`La intención '${options.intent}' no está registrada en el catálogo ejecutable.`);
    }

    // Validar parámetros con el esquema Zod de la intención
    const parseResult = intentDef.parametersSchema.safeParse(options.parameters);
    const validParams = parseResult.success ? parseResult.data : {};

    // Ejecutar con timeout de 5 segundos
    const executionPromise = intentDef.execute(fastify, organizationId, validParams, options.period);

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
            reject(new Error(`Timeout de ejecución excedido (${STATEMENT_TIMEOUT_MS}ms) para la intención '${options.intent}'.`));
        }, STATEMENT_TIMEOUT_MS);
    });

    return await Promise.race([executionPromise, timeoutPromise]);
}
