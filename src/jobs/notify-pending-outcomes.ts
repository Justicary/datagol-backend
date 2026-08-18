import { FastifyInstance } from 'fastify';
import { sendPendingOutcomeReminderEmail } from '../services/email.js';

export const NOTIFY_PENDING_OUTCOMES_QUEUE = 'notify-pending-outcomes';

const MIN_COUNT_TO_NOTIFY = 3;
const MIN_DAYS_OVERDUE_TO_NOTIFY = 3;
const MAX_APPOINTMENTS_PER_EMAIL = 20;

interface PendingOutcomeRow {
    id: string;
    organization_id: string;
    customer_name: string | null;
    start_time: string;
}

/**
 * Recordatorio diario de citas pasadas sin desenlace marcado (B.3,
 * docs/tasks/asistencia-valor de cierre.md) — "este job decide si la
 * feature funciona": sin él, `completada` nunca se llena y las métricas de
 * cumplimiento/valor quedan inservibles.
 *
 * Umbral (instrucción explícita del doc): NO notifica por una sola cita
 * reciente — solo cuando se acumulan 3 o más, o alguna lleva más de 3 días
 * sin marcarse.
 */
export async function notifyPendingOutcomesHandler(fastify: FastifyInstance): Promise<void> {
    const { data: rows, error } = await fastify.supabaseAdmin
        .from('v_citas_sin_desenlace')
        .select('id, organization_id, customer_name, start_time');

    if (error) {
        throw new Error(`No se pudo consultar v_citas_sin_desenlace: ${error.message}`);
    }

    const byOrg = new Map<string, PendingOutcomeRow[]>();
    for (const row of (rows ?? []) as PendingOutcomeRow[]) {
        const list = byOrg.get(row.organization_id) ?? [];
        list.push(row);
        byOrg.set(row.organization_id, list);
    }

    const now = Date.now();
    let notified = 0;

    for (const [organizationId, appointments] of byOrg) {
        const withDays = appointments.map((a) => ({
            ...a,
            daysOverdue: Math.floor((now - new Date(a.start_time).getTime()) / (24 * 60 * 60 * 1000)),
        }));

        const shouldNotify =
            withDays.length >= MIN_COUNT_TO_NOTIFY || withDays.some((a) => a.daysOverdue > MIN_DAYS_OVERDUE_TO_NOTIFY);
        if (!shouldNotify) continue;

        const { data: org } = await fastify.supabaseAdmin
            .from('organizations')
            .select('name, email')
            .eq('id', organizationId)
            .maybeSingle();
        if (!org?.email) {
            fastify.log.info({ organizationId }, '[NotifyPendingOutcomes] Organización sin email de notificación, se omite');
            continue;
        }

        const frontendUrl = process.env.FRONTEND_APP_URL;
        const dashboardUrl = frontendUrl
            ? `${frontendUrl.replace(/\/+$/, '')}/organizations/${organizationId}/appointments?filter=pending-outcome`
            : null;

        const emailResult = await sendPendingOutcomeReminderEmail({
            to: org.email,
            organizationId,
            data: {
                businessName: org.name,
                appointments: withDays
                    .sort((a, b) => b.daysOverdue - a.daysOverdue)
                    .slice(0, MAX_APPOINTMENTS_PER_EMAIL)
                    .map((a) => ({ customerName: a.customer_name, startTime: a.start_time, daysOverdue: a.daysOverdue })),
                dashboardUrl,
            },
        });

        if (emailResult) {
            notified += 1;
        } else {
            fastify.log.warn({ organizationId }, '[NotifyPendingOutcomes] No se pudo enviar el recordatorio');
        }
    }

    fastify.log.info(
        { organizationsChecked: byOrg.size, notified },
        '[NotifyPendingOutcomes] Recordatorio diario completado'
    );
}

export async function registerNotifyPendingOutcomesWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(NOTIFY_PENDING_OUTCOMES_QUEUE, { retryLimit: 2, retryBackoff: true });

    await fastify.pgBoss.work(NOTIFY_PENDING_OUTCOMES_QUEUE, async () => {
        await notifyPendingOutcomesHandler(fastify);
    });

    await fastify.pgBoss.schedule(NOTIFY_PENDING_OUTCOMES_QUEUE, '0 8 * * *', null, { tz: 'UTC' });
}
