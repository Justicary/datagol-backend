import { FastifyInstance } from 'fastify';
import { EVALUATE_WAITLIST_FOR_SLOT_QUEUE } from './evaluate-waitlist-for-slot.js';
import { WAITLIST_STATUSES } from '../types/waitlist.js';

export const CHECK_WAITLIST_EXPIRATIONS_QUEUE = 'check-waitlist-expirations';

const MAX_ROWS_PER_RUN = 200;

interface ExpiredOfferRow {
    id: string;
    organization_id: string;
    offered_slot_start: string | null;
    offered_slot_end: string | null;
}

/**
 * Sweep de ofertas de lista de espera vencidas
 * (docs/tasks/waitlist_confirmacion_masiva.md, Tarea B4). Corre cada 5
 * minutos (registrado abajo). Por cada oferta vencida que nadie tocó:
 * transición a `expirada` (condicional, protege contra una carrera con un
 * accept/reject que llegó justo antes de este tick) y reencola
 * `evaluate-waitlist-for-slot` para el mismo horario — reutiliza la
 * cola/servicio de la Tarea B3 en vez de reimplementar el matchmaking aquí.
 */
export async function checkWaitlistExpirationsHandler(fastify: FastifyInstance): Promise<void> {
    const nowIso = new Date().toISOString();

    const { data: expired, error } = await fastify.supabaseAdmin
        .from('appointment_waitlist')
        .select('id, organization_id, offered_slot_start, offered_slot_end')
        .eq('status', WAITLIST_STATUSES.OFERTADA)
        .lt('offer_expires_at', nowIso)
        .limit(MAX_ROWS_PER_RUN);

    if (error) {
        throw new Error(`No se pudo listar ofertas vencidas de appointment_waitlist: ${error.message}`);
    }

    let expiredCount = 0;
    let promotedCount = 0;

    for (const row of (expired ?? []) as ExpiredOfferRow[]) {
        const { data: claimed, error: claimError } = await fastify.supabaseAdmin
            .from('appointment_waitlist')
            .update({ status: WAITLIST_STATUSES.EXPIRADA })
            .eq('id', row.id)
            .eq('status', WAITLIST_STATUSES.OFERTADA)
            .select('id')
            .maybeSingle();

        if (claimError) {
            fastify.log.error({ waitlistId: row.id, err: claimError.message, msg: '[CheckWaitlistExpirations] Error al expirar la oferta' });
            continue;
        }
        if (!claimed) {
            // El cliente la aceptó/rechazó justo antes de este tick — carrera legítima, no error.
            continue;
        }
        expiredCount += 1;

        if (row.offered_slot_start && row.offered_slot_end) {
            await fastify.pgBoss.send(EVALUATE_WAITLIST_FOR_SLOT_QUEUE, {
                organizationId: row.organization_id,
                slotStartTime: row.offered_slot_start,
                slotEndTime: row.offered_slot_end,
            });
            promotedCount += 1;
        }
    }

    fastify.log.info(
        { checked: expired?.length ?? 0, expiredCount, promotedCount },
        '[CheckWaitlistExpirations] Barrido de ofertas vencidas completado'
    );
}

export async function registerCheckWaitlistExpirationsWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(CHECK_WAITLIST_EXPIRATIONS_QUEUE, { retryLimit: 3, retryBackoff: true });

    await fastify.pgBoss.work(CHECK_WAITLIST_EXPIRATIONS_QUEUE, async () => {
        await checkWaitlistExpirationsHandler(fastify);
    });

    // Cada 5 minutos (doc: "cada 2-5 minutos"; se toma el extremo superior,
    // suficiente frente al TTL mínimo razonable de 15 minutos).
    await fastify.pgBoss.schedule(CHECK_WAITLIST_EXPIRATIONS_QUEUE, '*/5 * * * *', null, { tz: 'UTC' });
}
