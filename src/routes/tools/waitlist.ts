import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveToolOrganization } from '../../lib/tool-auth.js';
import { getOrganizationFeatures } from '../../services/entitlements.js';
import { normalizePhoneE164 } from '../../services/phone-normalization.js';
import { resolveContactBestEffort } from './booking.js';
import { FEATURE_KEYS } from '../../types/feature-taxonomy.js';
import { WAITLIST_PRIORITIES, WAITLIST_STATUSES } from '../../types/waitlist.js';
import { toolParamsSchema, waitlistBodySchema, waitlistResponseSchema, isValidDateString } from '../../schemas/tool-routes.js';

const DEGRADED_MESSAGE = 'No puedo anotarte en la lista de espera en este momento, ¿te llamo de vuelta?';
const NOT_ELIGIBLE_MESSAGE =
    'Por ahora no contamos con lista de espera disponible, pero con gusto te ayudo a buscar otro horario o tomo tus datos para contactarte si se libera un espacio.';
const MISSING_PHONE_MESSAGE = 'Para anotarte en la lista de espera necesito tu número de teléfono, ¿me lo compartes?';

/**
 * POST /tools/:webhookToken/waitlist — Tarea B2
 * (docs/tasks/waitlist_confirmacion_masiva.md). Captura un prospecto en cola
 * cuando `availability.ts` no encontró cupo. Idempotente por
 * `conversationId` (ux_appointment_waitlist_org_conversation_id,
 * db/migrations/65_appointment_waitlist_idempotency.sql) — mismo criterio
 * que `booking.ts`.
 */
export async function waitlistToolRoute(fastify: FastifyInstance) {
    fastify.post('/tools/:webhookToken/waitlist', async (request: FastifyRequest, reply: FastifyReply) => {
        const paramsResult = toolParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'webhookToken inválido en la ruta' });
        }

        const secretHeader = request.headers['x-tool-secret'] as string | undefined;
        const auth = await resolveToolOrganization(fastify, paramsResult.data.webhookToken, secretHeader);
        if (!auth.ok) {
            const statusCode = auth.reason === 'suspended' ? 403 : 401;
            request.log.warn({ reason: auth.reason, route: 'waitlist', msg: 'Tool call rechazado' });
            return reply.status(statusCode).send({
                error: statusCode === 403 ? 'Forbidden' : 'Unauthorized',
                message: auth.message,
            });
        }

        const bodyResult = waitlistBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Cuerpo de la petición inválido' });
        }
        const {
            conversationId,
            customerName,
            customerPhone,
            customerEmail,
            partySize,
            preferredDateStart,
            preferredDateEnd,
            preferredTimeStart,
            preferredTimeEnd,
            notes,
        } = bodyResult.data;

        if (!isValidDateString(preferredDateStart) || !isValidDateString(preferredDateEnd)) {
            return reply.status(400).send({ error: 'BadRequest', message: 'preferredDateStart/preferredDateEnd no son fechas válidas' });
        }

        // Entitlement (AGENTS.md §16): se verifica aquí, no antes de encolar
        // nada — este es el único efecto de este tool. Plan sin `waitlist`
        // se degrada con cortesía, nunca con un 403 técnico que el agente no
        // puede verbalizar de forma útil.
        const features = await getOrganizationFeatures(auth.organizationId);
        if (!features.has(FEATURE_KEYS.WAITLIST)) {
            return reply.status(200).send(waitlistResponseSchema.parse({ waitlisted: false, message: NOT_ELIGIBLE_MESSAGE }));
        }

        const normalizedPhone = normalizePhoneE164(customerPhone);
        if (!normalizedPhone.success || !normalizedPhone.phoneE164) {
            return reply.status(200).send(waitlistResponseSchema.parse({ waitlisted: false, message: MISSING_PHONE_MESSAGE }));
        }
        const phoneE164 = normalizedPhone.phoneE164;

        // Idempotencia: un reintento con el mismo conversationId devuelve la
        // fila ya creada en vez de duplicarla (mismo patrón que booking.ts).
        const { data: existing } = await fastify.supabaseAdmin
            .from('appointment_waitlist')
            .select('id')
            .eq('organization_id', auth.organizationId)
            .eq('conversation_id', conversationId)
            .maybeSingle();

        if (existing) {
            return reply.status(200).send(
                waitlistResponseSchema.parse({
                    waitlisted: true,
                    message: 'Ya tenías tu lugar apartado en la lista de espera, te avisaremos en cuanto se libere un cupo.',
                    waitlistId: existing.id,
                })
            );
        }

        const priority = await resolveWaitlistPriority(fastify, auth.organizationId, phoneE164, customerEmail ?? null);
        const contactId = await resolveContactBestEffort(fastify, auth.organizationId, customerName, phoneE164, customerEmail ?? null);

        const { data: inserted, error: insertError } = await fastify.supabaseAdmin
            .from('appointment_waitlist')
            .insert({
                organization_id: auth.organizationId,
                contact_id: contactId,
                conversation_id: conversationId,
                customer_name: customerName,
                customer_phone: phoneE164,
                customer_email: customerEmail ?? null,
                party_size: partySize,
                preferred_date_start: preferredDateStart.slice(0, 10),
                preferred_date_end: preferredDateEnd.slice(0, 10),
                preferred_time_start: preferredTimeStart ?? null,
                preferred_time_end: preferredTimeEnd ?? null,
                status: WAITLIST_STATUSES.PENDIENTE,
                priority,
                notes: notes ?? null,
            })
            .select('id')
            .single();

        if (insertError) {
            if (insertError.code === '23505') {
                // Carrera: otra instancia insertó la misma conversationId primero.
                const { data: raceWinner } = await fastify.supabaseAdmin
                    .from('appointment_waitlist')
                    .select('id')
                    .eq('organization_id', auth.organizationId)
                    .eq('conversation_id', conversationId)
                    .maybeSingle();

                return reply.status(200).send(
                    waitlistResponseSchema.parse({
                        waitlisted: true,
                        message: 'Listo, quedaste registrado en la lista de espera. ¡Te avisaremos en cuanto se libere un cupo!',
                        waitlistId: raceWinner?.id ?? null,
                    })
                );
            }

            request.log.error({ organizationId: auth.organizationId, err: insertError.message, msg: 'Error insertando en appointment_waitlist' });
            return reply.status(200).send(waitlistResponseSchema.parse({ waitlisted: false, message: DEGRADED_MESSAGE }));
        }

        return reply.status(200).send(
            waitlistResponseSchema.parse({
                waitlisted: true,
                message: 'Listo, quedaste registrado en la lista de espera. ¡Te avisaremos en cuanto se libere un cupo!',
                waitlistId: inserted.id,
            })
        );
    });
}

/**
 * `priority: 'alta'` para clientes que ya existen en el CRM (`contacts`).
 * La clasificación "hot lead" del documento original (`leads.temperature`)
 * se calcula DESPUÉS de colgar (`call-sentiment.ts`, ejecutado por
 * `process-call-completed.ts`) — no existe todavía en el momento de este
 * tool call, que ocurre en vivo durante la llamada. "Cliente ya conocido"
 * es la señal más cercana disponible sin violar el presupuesto de latencia
 * de <300ms con una consulta adicional pesada.
 */
async function resolveWaitlistPriority(
    fastify: FastifyInstance,
    organizationId: string,
    phoneE164: string,
    email: string | null
): Promise<(typeof WAITLIST_PRIORITIES)[keyof typeof WAITLIST_PRIORITIES]> {
    const { data: byPhone } = await fastify.supabaseAdmin
        .from('contacts')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('phone_e164', phoneE164)
        .maybeSingle();
    if (byPhone) return WAITLIST_PRIORITIES.ALTA;

    if (email) {
        const { data: byEmail } = await fastify.supabaseAdmin
            .from('contacts')
            .select('id')
            .eq('organization_id', organizationId)
            .eq('email', email)
            .maybeSingle();
        if (byEmail) return WAITLIST_PRIORITIES.ALTA;
    }

    return WAITLIST_PRIORITIES.NORMAL;
}

export default waitlistToolRoute;
