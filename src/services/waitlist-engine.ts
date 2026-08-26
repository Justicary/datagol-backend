import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { hashToken } from '../lib/token-hash.js';
import { getSecret } from './secret-service.js';
import { getOrganizationFeatures } from './entitlements.js';
import { sendWaitlistOfferWhatsApp } from './waitlist-whatsapp.js';
import { VoiceProviderFactory } from './providers/VoiceProviderFactory.js';
import { SECRET_KEYS } from '../types/secret-keys.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { WAITLIST_STATUSES, WAITLIST_PRIORITIES, WAITLIST_NOTIFICATION_CHANNELS, type WaitlistPriority } from '../types/waitlist.js';

const DEFAULT_TTL_MINUTES = 15;

const PRIORITY_RANK: Record<WaitlistPriority, number> = {
    [WAITLIST_PRIORITIES.ALTA]: 0,
    [WAITLIST_PRIORITIES.NORMAL]: 1,
    [WAITLIST_PRIORITIES.BAJA]: 2,
};

export interface FreedSlot {
    /** ISO 8601 */
    startTime: string;
    /** ISO 8601 */
    endTime: string;
}

export interface EvaluateWaitlistResult {
    offered: boolean;
    waitlistId?: string;
    channel?: 'whatsapp' | 'voice';
    reason?: string;
}

interface CandidateRow {
    id: string;
    priority: string;
    created_at: string;
    preferred_time_start: string | null;
    preferred_time_end: string | null;
}

interface ClaimedRow {
    id: string;
    customer_name: string;
    customer_phone: string;
    customer_email: string | null;
    contact_id: string | null;
}

interface OrgRow {
    name: string;
    timezone: string;
    integration_settings: Record<string, unknown> | null;
    whatsapp_phone_number_id: string | null;
    active_voice_provider: string | null;
    [key: string]: unknown;
}

/**
 * Motor de matchmaking de la lista de espera
 * (docs/tasks/waitlist_confirmacion_masiva.md, Tarea B3). Se invoca al
 * liberarse un cupo (cancelación desde dashboard o por voz — ver
 * `src/jobs/evaluate-waitlist-for-slot.ts`). No se llama nunca desde el
 * camino crítico de una llamada en vivo: es trabajo diferido de pg-boss, sin
 * el presupuesto de <300ms de `routes/tools/**`.
 *
 * Emparejamiento SOLO por fecha/hora: `appointments` no tiene columna de
 * cupo/comensales (confirmado contra db/schema.md), así que `party_size` en
 * `appointment_waitlist` queda como dato informativo para el panel de
 * operación, no como filtro — decisión documentada, no una omisión.
 */
export async function evaluateWaitlistForSlot(
    fastify: FastifyInstance,
    organizationId: string,
    slot: FreedSlot
): Promise<EvaluateWaitlistResult> {
    const { data: org, error: orgError } = await fastify.supabaseAdmin
        .from('organizations')
        .select('name, timezone, integration_settings, whatsapp_phone_number_id, active_voice_provider')
        .eq('id', organizationId)
        .maybeSingle();

    if (orgError || !org) {
        fastify.log.error({ organizationId, err: orgError?.message, msg: 'waitlist-engine: organización no encontrada' });
        return { offered: false, reason: 'organizacion_no_encontrada' };
    }
    const orgRow = org as OrgRow;
    const timeZone = orgRow.timezone || 'America/Mexico_City';

    const candidate = await findBestCandidate(fastify, organizationId, slot, timeZone);
    if (!candidate) {
        return { offered: false, reason: 'sin_candidatos' };
    }

    const ttlMinutes = resolveTtlMinutes(orgRow.integration_settings);
    const offerExpiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();

    const features = await getOrganizationFeatures(organizationId);
    const whatsAppReady = await isWhatsAppReady(fastify, organizationId, orgRow, features);
    const rawToken = whatsAppReady ? crypto.randomBytes(32).toString('hex') : null;
    const initialChannel = whatsAppReady
        ? WAITLIST_NOTIFICATION_CHANNELS.WHATSAPP
        : WAITLIST_NOTIFICATION_CHANNELS.VOICE;

    // Claim atómico (WHERE status = 'pendiente'): evita ofertar el mismo
    // cupo dos veces si dos cancelaciones casi simultáneas disparan la
    // evaluación en paralelo para candidatos distintos que calzan el mismo
    // horario.
    const { data: claimed, error: claimError } = await fastify.supabaseAdmin
        .from('appointment_waitlist')
        .update({
            status: WAITLIST_STATUSES.OFERTADA,
            offered_at: new Date().toISOString(),
            offer_expires_at: offerExpiresAt,
            offer_token_hash: rawToken ? hashToken(rawToken) : null,
            offered_slot_start: slot.startTime,
            offered_slot_end: slot.endTime,
            notification_channel: initialChannel,
        })
        .eq('id', candidate.id)
        .eq('status', WAITLIST_STATUSES.PENDIENTE)
        .select('id, customer_name, customer_phone, customer_email, contact_id')
        .maybeSingle();

    if (claimError) {
        fastify.log.error({ organizationId, err: claimError.message, msg: 'waitlist-engine: error al reclamar la oferta' });
        return { offered: false, reason: 'error_claim' };
    }
    if (!claimed) {
        fastify.log.info({ organizationId, candidateId: candidate.id }, 'waitlist-engine: carrera perdida al reclamar la oferta, se omite');
        return { offered: false, reason: 'carrera_perdida' };
    }
    const claimedRow = claimed as ClaimedRow;

    if (whatsAppReady && rawToken) {
        const confirmationUrl = buildConfirmationUrl(rawToken);
        if (confirmationUrl) {
            const result = await sendWaitlistOfferWhatsApp(fastify, {
                organizationId,
                contactId: claimedRow.contact_id,
                phoneE164: claimedRow.customer_phone,
                customerName: claimedRow.customer_name,
                businessName: orgRow.name,
                confirmationUrl,
                slotDescription: formatSlotForSpeech(slot.startTime, timeZone),
            });

            if (result.sent) {
                return { offered: true, waitlistId: claimedRow.id, channel: 'whatsapp' };
            }

            fastify.log.warn(
                { organizationId, waitlistId: claimedRow.id, reason: result.skipReason ?? result.error, msg: 'waitlist-engine: WhatsApp no disponible, se degrada a voz' }
            );
            // El link ya generado nunca se entregó — invalidarlo antes de
            // caer a voz, no dejar un token válido sin dueño.
            await fastify.supabaseAdmin
                .from('appointment_waitlist')
                .update({ offer_token_hash: null, notification_channel: WAITLIST_NOTIFICATION_CHANNELS.VOICE })
                .eq('id', claimedRow.id);
        }
    }

    await triggerWaitlistVoiceFallback(fastify, organizationId, claimedRow, slot, orgRow, timeZone);
    return { offered: true, waitlistId: claimedRow.id, channel: 'voice' };
}

async function findBestCandidate(
    fastify: FastifyInstance,
    organizationId: string,
    slot: FreedSlot,
    timeZone: string
): Promise<CandidateRow | null> {
    const { date: slotDate, time: slotTime } = toOrgLocalParts(slot.startTime, timeZone);

    const { data: rows, error } = await fastify.supabaseAdmin
        .from('appointment_waitlist')
        .select('id, priority, created_at, preferred_time_start, preferred_time_end')
        .eq('organization_id', organizationId)
        .eq('status', WAITLIST_STATUSES.PENDIENTE)
        .lte('preferred_date_start', slotDate)
        .gte('preferred_date_end', slotDate)
        .order('created_at', { ascending: true })
        .limit(50);

    if (error) {
        fastify.log.error({ organizationId, err: error.message, msg: 'waitlist-engine: error consultando candidatos' });
        return null;
    }
    if (!rows || rows.length === 0) return null;

    const eligible = (rows as CandidateRow[]).filter((row) => {
        if (!row.preferred_time_start || !row.preferred_time_end) return true;
        return row.preferred_time_start <= slotTime && slotTime <= row.preferred_time_end;
    });
    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
        const rankDiff = PRIORITY_RANK[a.priority as WaitlistPriority] - PRIORITY_RANK[b.priority as WaitlistPriority];
        if (rankDiff !== 0) return rankDiff;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    return eligible[0];
}

function resolveTtlMinutes(integrationSettings: Record<string, unknown> | null): number {
    const raw = integrationSettings?.waitlist_ttl_minutes;
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MINUTES;
}

/**
 * WhatsApp solo se usa si: la feature `whatsapp` está entitled (mismo guard
 * que `thank-you-service.ts`), hay `whatsapp_phone_number_id` configurado,
 * existe el access token en el gestor de secretos, Y la organización ya
 * declaró una plantilla de Meta para la oferta
 * (`integration_settings.waitlist_whatsapp_template_name`) — sin plantilla
 * aprobada, un mensaje fuera de la ventana de 24h simplemente falla en Meta,
 * así que se trata como "no disponible" antes de intentarlo.
 */
async function isWhatsAppReady(
    fastify: FastifyInstance,
    organizationId: string,
    orgRow: OrgRow,
    features: Set<string>
): Promise<boolean> {
    if (!features.has(FEATURE_KEYS.WHATSAPP)) return false;
    if (!orgRow.whatsapp_phone_number_id) return false;

    const templateName = orgRow.integration_settings?.waitlist_whatsapp_template_name;
    if (typeof templateName !== 'string' || templateName.trim() === '') return false;

    const accessToken = await getSecret(organizationId, SECRET_KEYS.WHATSAPP_ACCESS_TOKEN);
    return Boolean(accessToken);
}

function buildConfirmationUrl(rawToken: string): string | null {
    const baseUrl = process.env.BACKEND_WEBHOOK_URL;
    if (!baseUrl) return null;
    return `${baseUrl.replace(/\/$/, '')}/api/waitlist/${rawToken}`;
}

async function triggerWaitlistVoiceFallback(
    fastify: FastifyInstance,
    organizationId: string,
    claimed: ClaimedRow,
    slot: FreedSlot,
    orgRow: OrgRow,
    timeZone: string
): Promise<void> {
    try {
        const provider = VoiceProviderFactory.getProvider(orgRow.active_voice_provider ?? undefined);
        const slotDescription = formatSlotForSpeech(slot.startTime, timeZone);

        await provider.triggerOutboundCall(
            {
                organizationId,
                customerPhone: claimed.customer_phone,
                customerName: claimed.customer_name,
                customerEmail: claimed.customer_email ?? undefined,
                companyName: orgRow.name,
                demoObjective: `Se liberó un cupo para ${slotDescription}, que ${claimed.customer_name} pidió en la lista de espera. Pregúntale si desea confirmarlo; si acepta, agenda la cita con la herramienta de reservas disponible. Si no contesta o rechaza, despídete con cortesía sin insistir.`,
                customVariables: {
                    waitlist_id: claimed.id,
                    offered_slot_start: slot.startTime,
                    offered_slot_end: slot.endTime,
                },
            },
            orgRow
        );
        fastify.log.info({ organizationId, waitlistId: claimed.id, msg: 'waitlist-engine: llamada de respaldo disparada' });
    } catch (err) {
        // No se relanza: la oferta ya quedó reclamada con su TTL. Si ni
        // WhatsApp ni voz llegaron al cliente, expira sola y el sweep de
        // expiración (Tarea B4) la ofrece al siguiente candidato.
        fastify.log.error(
            { organizationId, waitlistId: claimed.id, err: err instanceof Error ? err.message : String(err), msg: 'waitlist-engine: falló la llamada de voz de respaldo' }
        );
    }
}

function toOrgLocalParts(isoTime: string, timeZone: string): { date: string; time: string } {
    const d = new Date(isoTime);
    const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const timeFmt = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    return { date: dateFmt.format(d), time: timeFmt.format(d) };
}

function formatSlotForSpeech(isoTime: string, timeZone: string): string {
    const formatter = new Intl.DateTimeFormat('es-MX', {
        timeZone,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
    return formatter.format(new Date(isoTime));
}
