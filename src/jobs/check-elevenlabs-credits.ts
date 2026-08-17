import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { getSecret } from '../services/secret-service.js';
import { SECRET_KEYS } from '../types/secret-keys.js';
import { sendElevenLabsCreditsAlertEmail } from '../services/email.js';

export const CHECK_ELEVENLABS_CREDITS_SWEEP_QUEUE = 'check-elevenlabs-credits-sweep';
export const CHECK_ELEVENLABS_CREDITS_QUEUE = 'check-elevenlabs-credits';

const ELEVENLABS_SUBSCRIPTION_URL = 'https://api.elevenlabs.io/v1/user/subscription';
const ELEVENLABS_TIMEOUT_MS = 10_000;

/** Umbrales de crédito restante que disparan alerta, de mayor a menor. */
export const CREDIT_ALERT_THRESHOLDS = [15, 10, 5] as const;
export type CreditAlertThreshold = (typeof CREDIT_ALERT_THRESHOLDS)[number];

export interface CheckElevenLabsCreditsJobData {
    organizationId: string;
}

interface ElevenLabsSubscriptionResponse {
    character_count: number;
    character_limit: number;
    next_character_count_reset_unix: number;
}

function alertTypeFor(threshold: CreditAlertThreshold): string {
    return `elevenlabs_credits_${threshold}`;
}

/**
 * Mismo cálculo que `usagePercentage` del endpoint de suscripción del
 * frontend: porcentaje restante, no consumido.
 */
export function computeRemainingPercentage(characterCount: number, characterLimit: number): number {
    const used = Math.round((characterCount / characterLimit) * 100);
    return Math.max(0, Math.min(100, 100 - used));
}

/**
 * Sweep: encuentra las organizaciones con credencial de ElevenLabs dada de
 * alta y encola un chequeo individual por cada una. El chequeo en sí vive en
 * `checkElevenLabsCreditsHandler` para que un fallo de una organización
 * (API caída, credencial revocada) no reintente el sweep completo — solo
 * ese job individual.
 */
export async function checkElevenLabsCreditsSweepHandler(fastify: FastifyInstance): Promise<void> {
    const { data: orgSecrets, error } = await fastify.supabaseAdmin
        .from('organization_secrets')
        .select('organization_id')
        .eq('secret_key', SECRET_KEYS.ELEVENLABS_API_KEY);

    if (error) {
        throw new Error(`No se pudo listar organizaciones con credencial de ElevenLabs: ${error.message}`);
    }

    const organizationIds = Array.from(new Set((orgSecrets ?? []).map((row) => row.organization_id as string)));

    for (const organizationId of organizationIds) {
        await fastify.pgBoss.send(CHECK_ELEVENLABS_CREDITS_QUEUE, { organizationId });
    }

    fastify.log.info({ organizationCount: organizationIds.length }, 'check-elevenlabs-credits-sweep: chequeos encolados');
}

/**
 * Chequea el consumo de créditos de ElevenLabs de una organización y envía
 * una alerta por correo si el porcentaje restante cruzó hacia abajo alguno
 * de los umbrales 15/10/5. La deduplicación por ciclo de facturación vive en
 * la restricción UNIQUE de `organization_usage_alerts`
 * (organization_id, alert_type, cycle_reset_at): un umbral ya notificado en
 * el ciclo vigente simplemente no vuelve a insertarse.
 */
export async function checkElevenLabsCreditsHandler(fastify: FastifyInstance, job: Job<CheckElevenLabsCreditsJobData>): Promise<void> {
    const { organizationId } = job.data;

    const { data: org, error: orgError } = await fastify.supabaseAdmin
        .from('organizations')
        .select('name, email')
        .eq('id', organizationId)
        .single();

    if (orgError || !org?.email) {
        throw new Error(`organizations.id=${organizationId} sin email de notificación: ${orgError?.message ?? 'email vacío'}`);
    }

    const apiKey = await getSecret(organizationId, SECRET_KEYS.ELEVENLABS_API_KEY);
    if (!apiKey) {
        fastify.log.info({ organizationId }, 'check-elevenlabs-credits: sin credencial de ElevenLabs, se omite');
        return;
    }

    const response = await fetch(ELEVENLABS_SUBSCRIPTION_URL, {
        headers: { 'xi-api-key': apiKey },
        signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new Error(`ElevenLabs devolvió ${response.status} al consultar la suscripción de organizations.id=${organizationId}`);
    }

    const subscription = (await response.json()) as ElevenLabsSubscriptionResponse;

    if (!subscription.character_limit || subscription.character_limit <= 0) {
        fastify.log.info({ organizationId }, 'check-elevenlabs-credits: sin character_limit (plan sin tope), se omite');
        return;
    }

    if (!subscription.next_character_count_reset_unix) {
        throw new Error(`ElevenLabs no devolvió next_character_count_reset_unix para organizations.id=${organizationId}, no se puede deduplicar por ciclo`);
    }

    const remainingPercentage = computeRemainingPercentage(subscription.character_count, subscription.character_limit);
    const cycleResetAt = new Date(subscription.next_character_count_reset_unix * 1000).toISOString();

    for (const threshold of CREDIT_ALERT_THRESHOLDS) {
        if (remainingPercentage > threshold) {
            continue;
        }

        const { error: insertError } = await fastify.supabaseAdmin
            .from('organization_usage_alerts')
            .insert({
                organization_id: organizationId,
                alert_type: alertTypeFor(threshold),
                cycle_reset_at: cycleResetAt,
            });

        if (insertError) {
            if (insertError.code === '23505') {
                // Ya notificado este umbral en este ciclo; no reenviar.
                continue;
            }
            throw new Error(`No se pudo registrar la alerta de créditos (umbral ${threshold}) para organizations.id=${organizationId}: ${insertError.message}`);
        }

        const emailResponse = await sendElevenLabsCreditsAlertEmail({
            organizationId,
            to: org.email,
            organizationName: org.name,
            remainingPercentage,
            threshold,
        });

        if (!emailResponse) {
            throw new Error(`No se pudo enviar la alerta de créditos (umbral ${threshold}) para organizations.id=${organizationId}`);
        }

        fastify.log.info({ organizationId, threshold, remainingPercentage }, 'check-elevenlabs-credits: alerta enviada');
    }
}

/**
 * Registra las colas y workers de pg-boss, y programa el sweep recurrente
 * cada 6 horas.
 */
export async function registerCheckElevenLabsCreditsWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(CHECK_ELEVENLABS_CREDITS_SWEEP_QUEUE, {
        retryLimit: 3,
        retryBackoff: true,
    });
    await fastify.pgBoss.createQueue(CHECK_ELEVENLABS_CREDITS_QUEUE, {
        retryLimit: 3,
        retryBackoff: true,
    });

    await fastify.pgBoss.work(CHECK_ELEVENLABS_CREDITS_SWEEP_QUEUE, async () => {
        await checkElevenLabsCreditsSweepHandler(fastify);
    });

    await fastify.pgBoss.work<CheckElevenLabsCreditsJobData>(CHECK_ELEVENLABS_CREDITS_QUEUE, async ([job]) => {
        await checkElevenLabsCreditsHandler(fastify, job);
    });

    await fastify.pgBoss.schedule(CHECK_ELEVENLABS_CREDITS_SWEEP_QUEUE, '0 */6 * * *', null, { tz: 'UTC' });
}
