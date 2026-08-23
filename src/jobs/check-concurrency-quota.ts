import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { getSecret } from '../services/secret-service.js';
import { SECRET_KEYS } from '../types/secret-keys.js';

export const CHECK_CONCURRENCY_QUOTA_SWEEP_QUEUE = 'check-concurrency-quota-sweep';
export const CHECK_CONCURRENCY_QUOTA_QUEUE = 'check-concurrency-quota';

// NO VERIFICADO contra la documentación/API vigente de ElevenLabs (decisión
// explícita del usuario, docs/tasks/catalogo-productos-grupos-cred.md FASE
// B.4): se asume que `GET /v1/convai/conversations` acepta `agent_id` y
// `call_start_after_unix`, y que cada conversación trae `status` con valores
// como 'initiated'/'in-progress' mientras la llamada sigue en curso. Filtrar
// por "iniciada en los últimos N minutos + status activo" es una
// aproximación deliberada a "concurrencia ahora mismo": no existe (que se
// haya encontrado) un endpoint de "conteo de llamadas activas" documentado
// públicamente. Verificar contra el dashboard/API real de ElevenLabs antes
// de confiar en las cifras que produce este job para decisiones de negocio.
const ELEVENLABS_CONVERSATIONS_URL = 'https://api.elevenlabs.io/v1/convai/conversations';
const ELEVENLABS_TIMEOUT_MS = 10_000;
const ACTIVE_STATUSES = new Set(['initiated', 'in-progress']);
// Ventana de "recién iniciada": ninguna llamada de voz real dura más que
// esto (AGENTS.md: el backend no toca audio, pero las llamadas telefónicas
// de este dominio de negocio son de minutos, no de horas).
const RECENT_CALL_WINDOW_SECONDS = 60 * 60;

interface ElevenLabsConversationSummary {
    agent_id?: string;
    status?: string;
}

interface ElevenLabsConversationsListResponse {
    conversations?: ElevenLabsConversationSummary[];
    has_more?: boolean;
    next_cursor?: string | null;
}

export interface CheckConcurrencyQuotaJobData {
    credentialGroupId: string;
    ownerOrganizationId: string;
}

/**
 * Sweep: un chequeo por cada grupo de credenciales con owner y credencial de
 * ElevenLabs dada de alta. Igual que check-elevenlabs-credits.ts, el fallo de
 * un grupo (API caída, credencial revocada) no debe tumbar el sweep completo.
 */
export async function checkConcurrencyQuotaSweepHandler(fastify: FastifyInstance): Promise<void> {
    const { data: groups, error } = await fastify.supabaseAdmin
        .from('credential_groups')
        .select('id, owner_organization_id')
        .not('owner_organization_id', 'is', null);

    if (error) {
        throw new Error(`No se pudo listar credential_groups para el sweep de concurrencia: ${error.message}`);
    }

    for (const group of groups ?? []) {
        if (!group.owner_organization_id) continue;
        await fastify.pgBoss.send(CHECK_CONCURRENCY_QUOTA_QUEUE, {
            credentialGroupId: group.id,
            ownerOrganizationId: group.owner_organization_id,
        });
    }

    fastify.log.info({ groupCount: (groups ?? []).length }, 'check-concurrency-quota-sweep: chequeos encolados');
}

/**
 * Cuenta conversaciones activas por `agent_id` en el workspace del grupo
 * (una sola llamada a la API de ElevenLabs, paginada si hace falta), mapea
 * cada `agent_id` a su organización vía el índice único
 * `organizations.elevenlabs_agent_id`, y compara contra
 * `organization_concurrency_quota.soft_limit` de cada una. Al rebasar,
 * inserta un aviso en `concurrency_quota_alerts` (deduplicado por día) y
 * registra un warning — NUNCA rechaza ni afecta ninguna llamada en curso,
 * es visibilidad pura (AGENTS.md §16, mismo criterio que toda esta fase).
 */
export async function checkConcurrencyQuotaHandler(fastify: FastifyInstance, job: Job<CheckConcurrencyQuotaJobData>): Promise<void> {
    const { credentialGroupId, ownerOrganizationId } = job.data;

    const apiKey = await getSecret(ownerOrganizationId, SECRET_KEYS.ELEVENLABS_API_KEY);
    if (!apiKey) {
        fastify.log.info({ credentialGroupId, ownerOrganizationId }, 'check-concurrency-quota: sin credencial de ElevenLabs para el grupo, se omite');
        return;
    }

    const callStartAfterUnix = Math.floor(Date.now() / 1000) - RECENT_CALL_WINDOW_SECONDS;
    const countByAgentId = new Map<string, number>();
    let cursor: string | null = null;

    do {
        const url = new URL(ELEVENLABS_CONVERSATIONS_URL);
        url.searchParams.set('call_start_after_unix', String(callStartAfterUnix));
        url.searchParams.set('page_size', '100');
        if (cursor) url.searchParams.set('cursor', cursor);

        const response = await fetch(url, {
            headers: { 'xi-api-key': apiKey },
            signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw new Error(`ElevenLabs devolvió ${response.status} al listar conversaciones para credential_groups.id=${credentialGroupId}`);
        }

        const page = (await response.json()) as ElevenLabsConversationsListResponse;
        for (const conversation of page.conversations ?? []) {
            if (!conversation.agent_id || !conversation.status || !ACTIVE_STATUSES.has(conversation.status)) continue;
            countByAgentId.set(conversation.agent_id, (countByAgentId.get(conversation.agent_id) ?? 0) + 1);
        }

        cursor = page.has_more ? (page.next_cursor ?? null) : null;
    } while (cursor);

    if (countByAgentId.size === 0) {
        return;
    }

    const { data: orgs, error: orgsError } = await fastify.supabaseAdmin
        .from('organizations')
        .select('id, elevenlabs_agent_id')
        .eq('credential_group_id', credentialGroupId)
        .in('elevenlabs_agent_id', Array.from(countByAgentId.keys()));

    if (orgsError) {
        throw new Error(`No se pudo resolver organizaciones por elevenlabs_agent_id para credential_groups.id=${credentialGroupId}: ${orgsError.message}`);
    }

    for (const org of orgs ?? []) {
        const currentCount = countByAgentId.get(org.elevenlabs_agent_id as string) ?? 0;
        if (currentCount === 0) continue;

        const { data: quota } = await fastify.supabaseAdmin
            .from('organization_concurrency_quota')
            .select('soft_limit')
            .eq('organization_id', org.id)
            .maybeSingle();

        if (!quota || currentCount <= quota.soft_limit) continue;

        const { error: insertError } = await fastify.supabaseAdmin.from('concurrency_quota_alerts').insert({
            organization_id: org.id,
            credential_group_id: credentialGroupId,
            current_count: currentCount,
            soft_limit: quota.soft_limit,
        });

        if (insertError) {
            if (insertError.code === '23505') {
                // Ya se avisó hoy para esta organización — no reenviar.
                continue;
            }
            fastify.log.error({ organizationId: org.id, err: insertError.message, msg: 'check-concurrency-quota: no se pudo registrar el aviso' });
            continue;
        }

        fastify.log.warn(
            { organizationId: org.id, credentialGroupId, currentCount, softLimit: quota.soft_limit },
            'check-concurrency-quota: organización rebasó su cuota blanda de concurrencia (aviso, no se rechazó ninguna llamada)'
        );
    }
}

/**
 * Registra las colas y workers de pg-boss, y programa el sweep recurrente
 * cada 15 minutos — suficientemente frecuente para que el aviso siga siendo
 * accionable, sin acercarse al presupuesto de latencia de ninguna ruta (este
 * job no vive en routes/tools/**, no tiene contrato de latencia contractual).
 */
export async function registerCheckConcurrencyQuotaWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(CHECK_CONCURRENCY_QUOTA_SWEEP_QUEUE, {
        retryLimit: 3,
        retryBackoff: true,
    });
    await fastify.pgBoss.createQueue(CHECK_CONCURRENCY_QUOTA_QUEUE, {
        retryLimit: 3,
        retryBackoff: true,
    });

    await fastify.pgBoss.work(CHECK_CONCURRENCY_QUOTA_SWEEP_QUEUE, async () => {
        await checkConcurrencyQuotaSweepHandler(fastify);
    });

    await fastify.pgBoss.work<CheckConcurrencyQuotaJobData>(CHECK_CONCURRENCY_QUOTA_QUEUE, async ([job]) => {
        await checkConcurrencyQuotaHandler(fastify, job);
    });

    await fastify.pgBoss.schedule(CHECK_CONCURRENCY_QUOTA_SWEEP_QUEUE, '*/15 * * * *', null, { tz: 'UTC' });
}
