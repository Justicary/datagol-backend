import type { FastifyInstance } from 'fastify';
import { isValidUntilExpired } from '../services/quotations/quotation-validity.js';
import { QUOTATION_STATUSES } from '../types/quotation-status.js';
import { QUOTATION_EVENT_TYPES } from '../types/quotation-event-type.js';

export const SWEEP_QUOTATIONS_QUEUE = 'sweep-quotations';
const DEFAULT_CART_TTL_HOURS = 168;

export interface SweepQuotationsResult {
    abandonedCount: number;
    expiredCount: number;
}

/**
 * Job horario (`0 * * * *`) que barre cotizaciones:
 * 1. `borrador` sin actividad mayor a `cart_ttl_hours` -> `abandonada` (+ evento `abandonada`).
 * 2. `emitida` / `enviada` con `valid_until` vencido en la zona horaria de la organización -> `vencida` (+ evento `vencida`).
 *
 * La purga física de `abandonada` > 90 días vive separada en `purge_abandoned_quotations()` (pg_cron).
 */
export async function sweepQuotationsHandler(
    fastify: FastifyInstance,
    options?: { organizationId?: string; now?: Date }
): Promise<SweepQuotationsResult> {
    const now = options?.now ?? new Date();
    const nowMs = now.getTime();

    // 1. Cargar borradores candidatos (con actividad > 24h, el mínimo permitido de cart_ttl_hours)
    const minCutoffIso = new Date(nowMs - 24 * 3600 * 1000).toISOString();
    let draftQuery = fastify.supabaseAdmin
        .from('quotations')
        .select('id, organization_id, last_activity_at, last_conversation_id')
        .eq('status', QUOTATION_STATUSES.BORRADOR)
        .lte('last_activity_at', minCutoffIso);

    if (options?.organizationId) {
        draftQuery = draftQuery.eq('organization_id', options.organizationId);
    }

    const { data: candidateDrafts, error: draftsErr } = await draftQuery;
    if (draftsErr) {
        fastify.log.error({ err: draftsErr.message }, '[SweepQuotations] Error consultando borradores inactivos');
    }

    // 2. Cargar emitidas/enviadas con valid_until no nulo
    let activeQuery = fastify.supabaseAdmin
        .from('quotations')
        .select('id, organization_id, status, valid_until, last_conversation_id')
        .in('status', [QUOTATION_STATUSES.EMITIDA, QUOTATION_STATUSES.ENVIADA])
        .not('valid_until', 'is', null);

    if (options?.organizationId) {
        activeQuery = activeQuery.eq('organization_id', options.organizationId);
    }

    const { data: candidateActive, error: activeErr } = await activeQuery;
    if (activeErr) {
        fastify.log.error({ err: activeErr.message }, '[SweepQuotations] Error consultando cotizaciones activas');
    }

    const orgIds = Array.from(
        new Set([
            ...(candidateDrafts ?? []).map((r) => String(r.organization_id)),
            ...(candidateActive ?? []).map((r) => String(r.organization_id)),
        ])
    );

    if (orgIds.length === 0) {
        return { abandonedCount: 0, expiredCount: 0 };
    }

    const [{ data: settingsRows }, { data: orgRows }] = await Promise.all([
        fastify.supabaseAdmin
            .from('quotation_settings')
            .select('organization_id, cart_ttl_hours')
            .in('organization_id', orgIds),
        fastify.supabaseAdmin
            .from('organizations')
            .select('id, timezone')
            .in('id', orgIds),
    ]);

    const ttlByOrg = new Map<string, number>();
    for (const s of settingsRows ?? []) {
        ttlByOrg.set(String(s.organization_id), Number(s.cart_ttl_hours ?? DEFAULT_CART_TTL_HOURS));
    }

    const tzByOrg = new Map<string, string>();
    for (const o of orgRows ?? []) {
        tzByOrg.set(String(o.id), String(o.timezone || 'America/Mexico_City'));
    }

    let abandonedCount = 0;
    let expiredCount = 0;

    // Procesar borradores inactivos -> abandonada
    for (const draft of candidateDrafts ?? []) {
        const orgId = String(draft.organization_id);
        const ttlHours = ttlByOrg.get(orgId) ?? DEFAULT_CART_TTL_HOURS;
        const lastActivityMs = new Date(String(draft.last_activity_at)).getTime();
        if (Number.isNaN(lastActivityMs)) continue;

        if (nowMs - lastActivityMs >= ttlHours * 3600 * 1000) {
            const { data: updated, error: updErr } = await fastify.supabaseAdmin
                .from('quotations')
                .update({ status: QUOTATION_STATUSES.ABANDONADA })
                .eq('id', String(draft.id))
                .eq('organization_id', orgId)
                .eq('status', QUOTATION_STATUSES.BORRADOR)
                .select('id')
                .maybeSingle();

            if (!updErr && updated?.id) {
                abandonedCount += 1;
                await fastify.supabaseAdmin.from('quotation_events').insert({
                    organization_id: orgId,
                    quotation_id: String(draft.id),
                    event_type: QUOTATION_EVENT_TYPES.ABANDONADA,
                    conversation_id: (draft.last_conversation_id as string | null) ?? null,
                    payload: {
                        cart_ttl_hours: ttlHours,
                        last_activity_at: draft.last_activity_at,
                    },
                });
                fastify.log.info(
                    { tenant_id: orgId, quotation_id: draft.id, ttlHours },
                    '[SweepQuotations] Borrador marcado como abandonado por inactividad'
                );
            }
        }
    }

    // Procesar emitidas/enviadas vencidas -> vencida
    for (const quot of candidateActive ?? []) {
        const orgId = String(quot.organization_id);
        const validUntil = quot.valid_until as string | null;
        if (!validUntil) continue;

        const tz = tzByOrg.get(orgId) ?? 'America/Mexico_City';
        if (isValidUntilExpired(validUntil, tz, now)) {
            const { data: updated, error: updErr } = await fastify.supabaseAdmin
                .from('quotations')
                .update({ status: QUOTATION_STATUSES.VENCIDA })
                .eq('id', String(quot.id))
                .eq('organization_id', orgId)
                .in('status', [QUOTATION_STATUSES.EMITIDA, QUOTATION_STATUSES.ENVIADA])
                .select('id')
                .maybeSingle();

            if (!updErr && updated?.id) {
                expiredCount += 1;
                await fastify.supabaseAdmin.from('quotation_events').insert({
                    organization_id: orgId,
                    quotation_id: String(quot.id),
                    event_type: QUOTATION_EVENT_TYPES.VENCIDA,
                    conversation_id: (quot.last_conversation_id as string | null) ?? null,
                    payload: {
                        valid_until: validUntil,
                        previous_status: quot.status,
                    },
                });
                fastify.log.info(
                    { tenant_id: orgId, quotation_id: quot.id, validUntil },
                    '[SweepQuotations] Cotización marcada como vencida'
                );
            }
        }
    }

    return { abandonedCount, expiredCount };
}

export async function registerSweepQuotationsWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(SWEEP_QUOTATIONS_QUEUE, {
        retryLimit: 3,
        retryBackoff: true,
    });

    await fastify.pgBoss.work(SWEEP_QUOTATIONS_QUEUE, async () => {
        await sweepQuotationsHandler(fastify);
    });

    await fastify.pgBoss.schedule(SWEEP_QUOTATIONS_QUEUE, '0 * * * *', null, { tz: 'UTC' });
}
