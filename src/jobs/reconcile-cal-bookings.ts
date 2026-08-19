import { FastifyInstance } from 'fastify';
import { getBooking } from '../services/cal-com-tool-client.js';
import { APPOINTMENT_STATUSES } from '../types/appointment-status.js';

export const RECONCILE_CAL_BOOKINGS_QUEUE = 'reconcile-cal-bookings';

const RECONCILE_TIMEOUT_MS = 8_000;

/**
 * Reconciliación diaria (B.2, docs/tasks/asistencia-valor de cierre.md):
 * citas futuras con `cal_booking_id` que siguen `programada`/`confirmada`
 * de nuestro lado, pero que el cliente pudo haber cancelado directamente en
 * Cal.com (fuera del flujo del agente de voz). Solo reconcilia
 * cancelaciones — Cal.com no expone un dato de asistencia real automático
 * (ver comentario de `getBooking`), así que `completada`/`no_asistio` siguen
 * siendo 100% manuales (B.1/B.3).
 *
 * Cada cita se procesa de forma independiente: un error consultando Cal.com
 * para una (credencial revocada, timeout) se registra y se omite, nunca
 * aborta el resto de la reconciliación.
 */
export async function reconcileCalBookingsHandler(fastify: FastifyInstance): Promise<void> {
    const { data: appointments, error } = await fastify.supabaseAdmin
        .from('appointments')
        .select('id, organization_id, cal_booking_id, status')
        .not('cal_booking_id', 'is', null)
        .in('status', [APPOINTMENT_STATUSES.PROGRAMADA, APPOINTMENT_STATUSES.CONFIRMADA, APPOINTMENT_STATUSES.REPROGRAMADA])
        .gt('start_time', new Date().toISOString());

    if (error) {
        throw new Error(`No se pudo listar citas pendientes de reconciliar: ${error.message}`);
    }

    let reconciled = 0;

    for (const appointment of appointments ?? []) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), RECONCILE_TIMEOUT_MS);

        try {
            const booking = await getBooking(fastify, appointment.organization_id, appointment.cal_booking_id as string, controller.signal);

            if (booking.status.toLowerCase() === 'cancelled') {
                const { error: updateError, count } = await fastify.supabaseAdmin
                    .from('appointments')
                    .update({ status: APPOINTMENT_STATUSES.CANCELADA, status_updated_at: new Date().toISOString() }, { count: 'exact' })
                    .eq('id', appointment.id)
                    // Evita pisar un cambio manual concurrente (p. ej. un admin
                    // ya la marcó completada mientras corría este job).
                    .eq('status', appointment.status);

                if (updateError) {
                    fastify.log.warn(
                        { err: updateError.message, appointmentId: appointment.id },
                        '[ReconcileCalBookings] No se pudo actualizar la cita reconciliada'
                    );
                } else if ((count ?? 0) > 0) {
                    reconciled += 1;
                }
            }
        } catch (err) {
            fastify.log.warn(
                { err, appointmentId: appointment.id, organizationId: appointment.organization_id },
                '[ReconcileCalBookings] Error consultando Cal.com para una cita, se omite'
            );
        } finally {
            clearTimeout(timer);
        }
    }

    fastify.log.info(
        { checked: appointments?.length ?? 0, reconciled },
        '[ReconcileCalBookings] Reconciliación diaria completada'
    );
}

export async function registerReconcileCalBookingsWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(RECONCILE_CAL_BOOKINGS_QUEUE, { retryLimit: 2, retryBackoff: true });

    await fastify.pgBoss.work(RECONCILE_CAL_BOOKINGS_QUEUE, async () => {
        await reconcileCalBookingsHandler(fastify);
    });

    await fastify.pgBoss.schedule(RECONCILE_CAL_BOOKINGS_QUEUE, '0 4 * * *', null, { tz: 'UTC' });
}
