import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { hashToken } from '../../lib/token-hash.js';
import { escapeHtml } from '../../lib/html-escape.js';
import { withToolTimeout, TOOL_MUTATION_TIMEOUT_MS, ToolTimeoutError } from '../../lib/tool-timeout.js';
import { createBooking, CalCredentialsMissingError, CalProviderError } from '../../services/cal-com-tool-client.js';
import { EVALUATE_WAITLIST_FOR_SLOT_QUEUE } from '../../jobs/evaluate-waitlist-for-slot.js';
import { WAITLIST_STATUSES } from '../../types/waitlist.js';
import { APPOINTMENT_STATUSES } from '../../types/appointment-status.js';

const tokenParamsSchema = z.object({
    offerToken: z.string().regex(/^[0-9a-f]{64}$/),
});

interface WaitlistOfferRow {
    id: string;
    organization_id: string;
    contact_id: string | null;
    customer_name: string;
    customer_phone: string;
    customer_email: string | null;
    status: string;
    offer_expires_at: string | null;
    offer_viewed_at: string | null;
    offered_slot_start: string | null;
    offered_slot_end: string | null;
    organizations: { name: string; timezone: string; cal_event_type_id: number | null } | null;
}

/**
 * `routes/public/waitlist-confirmation.ts` — endpoint público sin sesión ni
 * `x-tool-secret` (docs/tasks/waitlist_confirmacion_masiva.md, diseño
 * validado con el usuario): el link de la oferta de WhatsApp
 * (`waitlist-engine.ts`) apunta aquí. Deliberadamente separado de
 * `routes/tools/**` y `routes/admin/**` para que la ausencia de auth sea
 * obvia por ubicación, no un descuido.
 *
 * GET es de solo lectura (evita que el pre-fetch de link-preview de WhatsApp
 * ejecute la confirmación por sí solo); la acción real solo ocurre en el
 * POST que dispara el botón que el humano toca en la página.
 */
export async function waitlistConfirmationRoutes(fastify: FastifyInstance) {
    fastify.addHook('onSend', async (_request, reply, payload) => {
        reply.header('Cache-Control', 'no-store');
        return payload;
    });

    fastify.get('/api/waitlist/:offerToken', async (request, reply) => {
        const paramsResult = tokenParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return sendPage(reply, invalidOfferPage());
        }

        const offer = await findOfferByRawToken(fastify, paramsResult.data.offerToken);
        if (!offer || !isOfferOpen(offer)) {
            return sendPage(reply, invalidOfferPage());
        }

        // Diagnóstico best-effort, nunca condiciona la elegibilidad de la
        // oferta ni bloquea el render — un bot de preview de WhatsApp puede
        // disparar este GET antes que el humano.
        void fastify.supabaseAdmin
            .from('appointment_waitlist')
            .update({ offer_viewed_at: new Date().toISOString() })
            .eq('id', offer.id)
            .is('offer_viewed_at', null)
            .then(undefined, (err) => request.log.warn({ err, waitlistId: offer.id }, 'waitlist-confirmation: no se pudo registrar offer_viewed_at'));

        return sendPage(reply, offerPage(offer, paramsResult.data.offerToken));
    });

    fastify.post('/api/waitlist/:offerToken/confirmar', async (request, reply) => {
        const paramsResult = tokenParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return sendPage(reply, invalidOfferPage());
        }

        const tokenHash = hashToken(paramsResult.data.offerToken);

        // Claim atómico: solo transiciona si SIGUE en 'ofertada' y no venció
        // — mismo criterio de update condicional que booking.ts/cancel.ts.
        // Si esto afecta 0 filas, alguien más (doble tap, o el futuro sweep
        // de expiración) ya resolvió esta oferta; se trata como carrera
        // legítima, no como error.
        const { data: claimed, error: claimError } = await fastify.supabaseAdmin
            .from('appointment_waitlist')
            .update({ status: WAITLIST_STATUSES.CONFIRMADA })
            .eq('offer_token_hash', tokenHash)
            .eq('status', WAITLIST_STATUSES.OFERTADA)
            .gt('offer_expires_at', new Date().toISOString())
            .select(
                'id, organization_id, contact_id, customer_name, customer_phone, customer_email, offered_slot_start, offered_slot_end'
            )
            .maybeSingle();

        if (claimError) {
            request.log.error({ err: claimError.message, msg: 'waitlist-confirmation: error al reclamar confirmación' });
            return sendPage(reply, errorPage());
        }
        if (!claimed) {
            return sendPage(reply, invalidOfferPage());
        }

        const { data: org } = await fastify.supabaseAdmin
            .from('organizations')
            .select('name, timezone, cal_event_type_id')
            .eq('id', claimed.organization_id)
            .maybeSingle();

        let calBookingId: string | null = null;
        let finalStart = claimed.offered_slot_start as string;
        let finalEnd = claimed.offered_slot_end as string;

        // Mismo criterio best-effort que cancel.ts: el cliente ya decidió
        // confirmar, no se le niega la cita local por un tropiezo de Cal.com.
        if (org?.cal_event_type_id) {
            try {
                const calResult = await withToolTimeout(
                    (signal) =>
                        createBooking(
                            fastify,
                            claimed.organization_id,
                            {
                                eventTypeId: org.cal_event_type_id!,
                                customerName: claimed.customer_name,
                                customerEmail: claimed.customer_email,
                                customerPhone: claimed.customer_phone,
                                startTime: finalStart,
                                timeZone: org.timezone,
                            },
                            signal
                        ),
                    TOOL_MUTATION_TIMEOUT_MS
                );
                calBookingId = calResult.calBookingId;
                finalStart = calResult.startTime;
                finalEnd = calResult.endTime ?? finalEnd;
            } catch (err) {
                logDegradedCalFailure(fastify, claimed.organization_id, err);
            }
        }

        const { data: appointment, error: insertError } = await fastify.supabaseAdmin
            .from('appointments')
            .insert({
                organization_id: claimed.organization_id,
                contact_id: claimed.contact_id,
                customer_name: claimed.customer_name,
                customer_email: claimed.customer_email,
                customer_phone: claimed.customer_phone,
                start_time: finalStart,
                end_time: finalEnd,
                cal_booking_id: calBookingId,
                status: APPOINTMENT_STATUSES.CONFIRMADA,
            })
            .select('id')
            .single();

        if (insertError) {
            fastify.log.error(
                { organizationId: claimed.organization_id, waitlistId: claimed.id, err: insertError.message, msg: 'waitlist-confirmation: cita confirmada en waitlist pero falló INSERT en appointments' }
            );
            return sendPage(reply, errorPage());
        }

        await fastify.supabaseAdmin
            .from('appointment_waitlist')
            .update({ offered_appointment_id: appointment.id })
            .eq('id', claimed.id);

        return sendPage(reply, confirmedPage(org?.name ?? 'el negocio', finalStart, org?.timezone ?? 'America/Mexico_City'));
    });

    fastify.post('/api/waitlist/:offerToken/rechazar', async (request, reply) => {
        const paramsResult = tokenParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return sendPage(reply, invalidOfferPage());
        }

        const tokenHash = hashToken(paramsResult.data.offerToken);

        // Sin filtro de expiración a propósito: rechazar una oferta técnicamente
        // vencida (el cliente tardó en tocar el link) sigue siendo una señal
        // útil — adelanta la promoción del siguiente candidato en vez de
        // esperar al sweep de expiración.
        const { data: claimed, error: claimError } = await fastify.supabaseAdmin
            .from('appointment_waitlist')
            .update({ status: WAITLIST_STATUSES.RECHAZADA })
            .eq('offer_token_hash', tokenHash)
            .eq('status', WAITLIST_STATUSES.OFERTADA)
            .select('id, organization_id, offered_slot_start, offered_slot_end')
            .maybeSingle();

        if (claimError) {
            request.log.error({ err: claimError.message, msg: 'waitlist-confirmation: error al reclamar rechazo' });
            return sendPage(reply, errorPage());
        }
        if (!claimed) {
            return sendPage(reply, invalidOfferPage());
        }

        if (claimed.offered_slot_start && claimed.offered_slot_end) {
            try {
                await fastify.pgBoss.send(EVALUATE_WAITLIST_FOR_SLOT_QUEUE, {
                    organizationId: claimed.organization_id,
                    slotStartTime: claimed.offered_slot_start,
                    slotEndTime: claimed.offered_slot_end,
                });
            } catch (err) {
                request.log.warn(
                    { organizationId: claimed.organization_id, waitlistId: claimed.id, err: err instanceof Error ? err.message : String(err), msg: 'waitlist-confirmation: no se pudo encolar la promoción del siguiente candidato' }
                );
            }
        }

        return sendPage(reply, rejectedPage());
    });
}

async function findOfferByRawToken(fastify: FastifyInstance, rawToken: string): Promise<WaitlistOfferRow | null> {
    const tokenHash = hashToken(rawToken);
    const { data, error } = await fastify.supabaseAdmin
        .from('appointment_waitlist')
        .select(
            'id, organization_id, contact_id, customer_name, customer_phone, customer_email, status, offer_expires_at, offer_viewed_at, offered_slot_start, offered_slot_end, organizations(name, timezone, cal_event_type_id)'
        )
        .eq('offer_token_hash', tokenHash)
        .maybeSingle();

    if (error || !data) return null;
    return data as unknown as WaitlistOfferRow;
}

function isOfferOpen(offer: WaitlistOfferRow): boolean {
    if (offer.status !== WAITLIST_STATUSES.OFERTADA) return false;
    if (!offer.offer_expires_at) return false;
    return new Date(offer.offer_expires_at).getTime() > Date.now();
}

function logDegradedCalFailure(fastify: FastifyInstance, organizationId: string, err: unknown): void {
    if (err instanceof CalCredentialsMissingError) {
        fastify.log.error({ organizationId, msg: 'waitlist-confirmation: cal_api_key no configurado, se confirma solo localmente' });
    } else if (err instanceof ToolTimeoutError) {
        fastify.log.warn({ organizationId, msg: 'waitlist-confirmation: timeout creando la reserva en Cal.com, se confirma solo localmente' });
    } else if (err instanceof CalProviderError) {
        fastify.log.warn({ organizationId, status: err.status, msg: 'waitlist-confirmation: Cal.com respondió error, se confirma solo localmente' });
    } else {
        fastify.log.error({ organizationId, err: err instanceof Error ? err.message : String(err), msg: 'waitlist-confirmation: error inesperado creando la reserva en Cal.com' });
    }
}

function sendPage(reply: FastifyReply, bodyHtml: string) {
    return reply.status(200).type('text/html; charset=utf-8').send(pageShell(bodyHtml));
}

function pageShell(bodyHtml: string): string {
    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Confirmación de cupo</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #f4f4f5; margin: 0; padding: 24px 16px; color: #18181b; }
  .card { max-width: 420px; margin: 40px auto; background: #fff; border-radius: 12px; padding: 28px 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 15px; line-height: 1.5; color: #3f3f46; }
  .actions { display: flex; gap: 12px; margin-top: 20px; }
  button { flex: 1; padding: 14px; border-radius: 8px; border: none; font-size: 15px; font-weight: 600; cursor: pointer; }
  .accept { background: #16a34a; color: #fff; }
  .reject { background: #e4e4e7; color: #27272a; }
</style>
</head>
<body>
<div class="card">${bodyHtml}</div>
</body>
</html>`;
}

function offerPage(offer: WaitlistOfferRow, rawToken: string): string {
    const businessName = escapeHtml(offer.organizations?.name ?? 'el negocio');
    const slotText = offer.offered_slot_start
        ? escapeHtml(formatSlotForDisplay(offer.offered_slot_start, offer.organizations?.timezone ?? 'America/Mexico_City'))
        : 'el horario liberado';
    // Rutas absolutas, no relativas: la ruta base no termina en "/", así que
    // "./confirmar" resolvería a /api/waitlist/confirmar (perdiendo el
    // token) en vez de /api/waitlist/:offerToken/confirmar. El token ya está
    // validado contra /^[0-9a-f]{64}$/ antes de llegar aquí.
    const encodedToken = encodeURIComponent(rawToken);

    return `
<h1>¡Se liberó un cupo!</h1>
<p>${businessName} te ofrece el horario de <strong>${slotText}</strong>. ¿Deseas confirmarlo?</p>
<div class="actions">
  <form method="POST" action="/api/waitlist/${encodedToken}/confirmar" style="flex:1">
    <button type="submit" class="accept">Confirmar</button>
  </form>
  <form method="POST" action="/api/waitlist/${encodedToken}/rechazar" style="flex:1">
    <button type="submit" class="reject">Rechazar</button>
  </form>
</div>`;
}

function confirmedPage(businessName: string, startTime: string, timeZone: string): string {
    const slotText = escapeHtml(formatSlotForDisplay(startTime, timeZone));
    return `<h1>¡Listo!</h1><p>Tu cita con ${escapeHtml(businessName)} quedó confirmada para <strong>${slotText}</strong>.</p>`;
}

function rejectedPage(): string {
    return `<h1>Entendido</h1><p>Gracias por avisarnos. Le ofreceremos este cupo a otra persona en la lista de espera.</p>`;
}

function invalidOfferPage(): string {
    return `<h1>Esta oferta ya no está disponible</h1><p>Es posible que ya haya sido confirmada, rechazada o que el tiempo para responder haya vencido.</p>`;
}

function errorPage(): string {
    return `<h1>Algo salió mal</h1><p>No pudimos procesar tu respuesta en este momento. Por favor contacta directamente al negocio.</p>`;
}

function formatSlotForDisplay(isoTime: string, timeZone: string): string {
    return new Intl.DateTimeFormat('es-MX', {
        timeZone,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    }).format(new Date(isoTime));
}

export default waitlistConfirmationRoutes;
