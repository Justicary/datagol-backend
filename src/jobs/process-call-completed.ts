import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { mapElevenLabsPayload } from '../services/call-payload-mapper.js';
import { extractTimezoneFromElevenLabsPayload } from '../services/elevenlabs-timezone.js';
import { geocodeAddress } from '../services/geocoding.js';
import { resolveCallUsageEntries } from '../services/usage-registration.js';
import { LEAD_TEMPERATURES, LEAD_CHANNELS, LEAD_FOLLOWUP_STATUSES } from '../types/lead-enums.js';
import { CONTACT_ADDRESS_TYPES } from '../types/contact-enums.js';
import { NOTIFY_HOT_LEAD_QUEUE } from './notify-hot-lead.js';
import { SEND_CALL_SUMMARY_QUEUE } from './send-call-summary.js';
import { SEND_PROSPECT_SUMMARY_QUEUE } from './send-prospect-summary.js';
import { SEND_THANK_YOU_QUEUE } from './send-thank-you.js';

export const PROCESS_CALL_COMPLETED_QUEUE = 'process-call-completed';

export interface ProcessCallCompletedJobData {
    webhookEventId: string;
}

/**
 * Procesa un evento `webhook_events` de ElevenLabs ya verificado: mapea el
 * payload y lo persiste de forma atómica vía el RPC `process_call_completed`
 * (upsert de contacto, upsert de call_log, insert idempotente de lead, y
 * registro de consumo en `usage_events` — Fase 3), y encola las
 * notificaciones de Fase 4 (`notify-hot-lead`, `send-call-summary`,
 * `send-prospect-summary`).
 *
 * Las features de cada notificación (`hot_lead_alerts`, `email_summaries`)
 * se verifican dentro de cada worker, no aquí (AGENTS.md §16: "verificar la
 * feature antes de ejecutar el efecto, no antes de encolar").
 */
export async function processCallCompletedHandler(fastify: FastifyInstance, job: Job<ProcessCallCompletedJobData>): Promise<void> {
    const { webhookEventId } = job.data;

    const { data: event, error: fetchError } = await fastify.supabaseAdmin
        .from('webhook_events')
        .select('id, organization_id, raw_payload, processed_at')
        .eq('id', webhookEventId)
        .single();

    if (fetchError || !event) {
        throw new Error(`No se encontró webhook_events.id=${webhookEventId}: ${fetchError?.message ?? 'sin datos'}`);
    }

    if (event.processed_at) {
        // Ya procesado en una ejecución previa del job (reintento de pg-boss); no repetir efectos.
        return;
    }

    if (!event.organization_id) {
        throw new Error(`webhook_events.id=${webhookEventId} no tiene organization_id resuelto`);
    }

    let mapped;
    try {
        mapped = mapElevenLabsPayload(event.raw_payload);
    } catch (mapError: any) {
        await fastify.supabaseAdmin
            .from('webhook_events')
            .update({ error: mapError.message })
            .eq('id', webhookEventId);
        throw mapError;
    }

    if (!mapped) {
        // Tipo de evento fuera de alcance de la Fase 2 (p. ej. post_call_audio).
        await fastify.supabaseAdmin
            .from('webhook_events')
            .update({ processed_at: new Date().toISOString() })
            .eq('id', webhookEventId);
        return;
    }

    // Fase 3 — Metering: resuelve los asientos de consumo (tarifa histórica
    // incluida) ANTES del RPC, para insertarlos en la misma transacción que
    // el contacto/call_log/lead.
    const usageEntries = await resolveCallUsageEntries(fastify, {
        organizationId: event.organization_id,
        conversationId: mapped.conversationId,
        durationSeconds: mapped.durationSeconds,
        occurredAt: mapped.occurredAt,
        hasPhoneCallLeg: mapped.hasPhoneCallLeg,
        isTextChannel: mapped.isTextChannel,
        textMessageQuantity: mapped.whatsappMessageQuantity,
        llmTokenUsage: mapped.llmTokenUsage,
        isBurst: mapped.isBurst,
    });

    // Geocodificación (opcional por organización, ver services/geocoding.ts):
    // resuelta ANTES del RPC porque process_call_completed solo persiste, no
    // llama a proveedores externos. Sin google_maps_key configurada o sin
    // dirección capturada, geocodeAddress devuelve null y lat/lng quedan
    // NULL en call_logs — la dirección en texto se guarda de todos modos.
    const geocoded = await geocodeAddress(fastify, event.organization_id, {
        address: mapped.address,
        city: mapped.city,
        state: mapped.state,
        zip: mapped.zip,
    });

    const { data: result, error: rpcError } = await fastify.supabaseAdmin.rpc('process_call_completed', {
        p_organization_id: event.organization_id,
        p_conversation_id: mapped.conversationId,
        p_provider_call_id: mapped.providerCallId,
        p_caller_phone_e164: mapped.callerPhoneE164,
        p_full_name: mapped.fullName,
        p_email: mapped.email,
        p_business_name: mapped.businessName,
        p_business_sector: mapped.businessSector,
        p_contact_phone_raw: mapped.contactPhoneRaw,
        p_inquiry_reason: mapped.inquiryReason,
        p_plan_of_interest: mapped.planOfInterest,
        p_temperature: mapped.temperature,
        p_source: mapped.source,
        p_source_detail: mapped.sourceDetail,
        p_sentiment: mapped.sentiment,
        p_booked_appointment: mapped.bookedAppointment,
        p_needs_followup: mapped.needsFollowup,
        p_followup_notes: mapped.followupNotes,
        p_call_volume: mapped.callVolume,
        p_transcript: mapped.transcript,
        p_summary: mapped.summary,
        p_duration_seconds: mapped.durationSeconds,
        p_usage_entries: usageEntries,
        p_channel: mapped.channel,
        p_customer_address: mapped.address || geocoded?.formattedAddress || null,
        p_customer_city: mapped.city || geocoded?.city || null,
        p_customer_state: mapped.state || geocoded?.state || null,
        p_customer_zip: mapped.zip || geocoded?.postalCode || null,
        p_customer_lat: geocoded?.lat ?? null,
        p_customer_lng: geocoded?.lng ?? null,
    });

    if (rpcError) {
        await fastify.supabaseAdmin
            .from('webhook_events')
            .update({ error: rpcError.message })
            .eq('id', webhookEventId);
        throw new Error(`process_call_completed falló para webhook_events.id=${webhookEventId}: ${rpcError.message}`);
    }

    // A.1 (docs/tasks/reportes-semanales.md) — siembra oportunista de
    // organizations.timezone desde el payload crudo de ElevenLabs, si trae
    // una zona horaria válida (ver services/elevenlabs-timezone.ts sobre por
    // qué es puramente best-effort). Nunca bloquea el job: un error aquí solo
    // se registra.
    const seededTimezone = extractTimezoneFromElevenLabsPayload(event.raw_payload);
    if (seededTimezone) {
        const { error: timezoneError } = await fastify.supabaseAdmin
            .from('organizations')
            .update({ timezone: seededTimezone })
            .eq('id', event.organization_id);

        if (timezoneError) {
            fastify.log.warn({
                webhookEventId,
                organizationId: event.organization_id,
                err: timezoneError.message,
                msg: 'No se pudo sembrar organizations.timezone desde el payload de ElevenLabs',
            });
        }
    }

    // Fase B (docs/tasks/opus.md) — consolidar la dirección capturada por el
    // agente en el contacto, no dejarla morir solo en call_logs. Best-effort
    // y DESPUÉS del RPC (que ya persistió contacto/call_log/lead/usage_events
    // con éxito): un fallo aquí no debe reintentar todo el job vía pg-boss,
    // solo perderse esta consolidación puntual — se registra para poder
    // investigarla.
    if (result?.contact_id && (mapped.address || geocoded?.formattedAddress)) {
        const street = mapped.address || geocoded?.street || geocoded?.formattedAddress;
        const city = mapped.city || geocoded?.city || null;
        const state = mapped.state || geocoded?.state || null;
        const postalCode = mapped.zip || geocoded?.postalCode || null;
        const neighborhood = geocoded?.neighborhood || null;

        const { error: addressError } = await fastify.supabaseAdmin.rpc('resolve_contact_address', {
            p_org_id: event.organization_id,
            p_contact_id: result.contact_id,
            p_street: street,
            p_city: city,
            p_state: state,
            p_postal_code: postalCode,
            p_lat: geocoded?.lat ?? null,
            p_lng: geocoded?.lng ?? null,
            p_type: CONTACT_ADDRESS_TYPES.DOMICILIO,
            p_neighborhood: neighborhood,
            p_label: 'Mi Casa',
        });

        if (addressError) {
            fastify.log.warn({
                webhookEventId,
                organizationId: event.organization_id,
                contactId: result.contact_id,
                err: addressError.message,
                msg: 'No se pudo consolidar la dirección del prospecto en contact_addresses',
            });
        }
    }

    // Respaldo de `whatsapp_messages` por turno individual (docs pendiente
    // 2026-08-11, datagol-frontend): ElevenLabs no expone ningún webhook por
    // mensaje individual (solo éste, post-llamada) — Meta le entrega los
    // webhooks de WhatsApp directo a ElevenLabs, nunca a este backend. No hay
    // forma de mostrar el chat en vivo con la integración actual; esto solo
    // reemplaza el párrafo único de `call_logs.transcript` por burbujas
    // individuales en el panel del dashboard, disponibles al terminar la
    // conversación, no durante ella.
    //
    // `wa_message_id` sintético (`backfill:{conversationId}:{índice}`), no un
    // ID real de Meta — ElevenLabs no entrega uno por turno. Existe solo para
    // que la restricción UNIQUE de la columna deduplique reintentos de este
    // job (idempotencia): un reintento reenvía las mismas filas con el mismo
    // ID sintético, `ignoreDuplicates` las descarta sin error.
    if (result?.contact_id && mapped.channel === LEAD_CHANNELS.WHATSAPP && mapped.transcriptTurns.length > 0) {
        const whatsappMessageRows = mapped.transcriptTurns.map((turn, index) => ({
            organization_id: event.organization_id,
            contact_id: result.contact_id,
            direction: turn.role === 'user' ? 'inbound' : 'outbound',
            body: turn.message,
            wa_message_id: `backfill:${mapped.conversationId}:${index}`,
        }));

        const { error: whatsappMessagesError } = await fastify.supabaseAdmin
            .from('whatsapp_messages')
            .upsert(whatsappMessageRows, { onConflict: 'wa_message_id', ignoreDuplicates: true });

        if (whatsappMessagesError) {
            fastify.log.warn({
                webhookEventId,
                organizationId: event.organization_id,
                contactId: result.contact_id,
                err: whatsappMessagesError.message,
                msg: 'No se pudo respaldar el transcript en whatsapp_messages',
            });
        }
    }

    // Confirmación de cita: si la llamada concluyó exitosamente como confirmación de cita
    // o agendamiento sin requerir seguimiento manual adicional, resolver los leads pendientes
    // asociados al contacto para no dejar tareas duplicadas en "Por atender".
    if (result?.contact_id && (mapped.inquiryReason === 'Confirmación de cita agendada' || mapped.bookedAppointment) && !mapped.needsFollowup) {
        try {
            await fastify.supabaseAdmin
                .from('leads')
                .update({
                    followup_status: LEAD_FOLLOWUP_STATUSES.DESCARTADO,
                    needs_followup: false,
                })
                .eq('organization_id', event.organization_id)
                .eq('contact_id', result.contact_id)
                .eq('followup_status', LEAD_FOLLOWUP_STATUSES.PENDIENTE);

            await fastify.supabaseAdmin
                .from('appointments')
                .update({
                    status: 'confirmada',
                    confirmation_requested_at: new Date().toISOString(),
                })
                .eq('organization_id', event.organization_id)
                .eq('contact_id', result.contact_id)
                .eq('status', 'programada');
        } catch (resolveErr: unknown) {
            const errMessage = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
            fastify.log.warn({
                webhookEventId,
                organizationId: event.organization_id,
                contactId: result.contact_id,
                err: errMessage,
                msg: 'No se pudieron resolver automáticamente los leads/citas de confirmación pendientes',
            });
        }
    }

    // Fase 4 — Encolar notificaciones. Los workers vuelven a verificar sus
    // propias condiciones (idempotencia, feature, opt-out) antes de enviar
    // nada, así que reintentos de este job (que reencolarían) son inofensivos.
    if (result?.call_log_id) {
        // 4.2 — Minuta de cada conversación completada. Prioridad estándar.
        await fastify.pgBoss.send(SEND_CALL_SUMMARY_QUEUE, { callLogId: result.call_log_id });
    }

    if (result?.lead_id) {
        if (mapped.temperature === LEAD_TEMPERATURES.CALIENTE && !mapped.bookedAppointment) {
            // 4.1 — El producto: prioridad alta para cumplir el objetivo de <1 minuto.
            await fastify.pgBoss.send(NOTIFY_HOT_LEAD_QUEUE, { leadId: result.lead_id }, { priority: 10 });
        }

        if (mapped.needsFollowup) {
            // 4.3 — El worker resuelve el correo (COALESCE lead/contacto) y el opt-out.
            await fastify.pgBoss.send(SEND_PROSPECT_SUMMARY_QUEUE, { leadId: result.lead_id });
        }

        // Agradecimiento automático omnicanal (docs/tasks/agradecimiento-automatico.md)
        await fastify.pgBoss.send(SEND_THANK_YOU_QUEUE, { leadId: result.lead_id });
    }

    await fastify.supabaseAdmin
        .from('webhook_events')
        .update({ processed_at: new Date().toISOString() })
        .eq('id', webhookEventId);

    fastify.log.info({
        webhookEventId,
        organizationId: event.organization_id,
        result,
        msg: 'process-call-completed: llamada persistida correctamente',
    });
}

/**
 * Registra la cola y el worker de pg-boss para `process-call-completed`.
 */
export async function registerProcessCallCompletedWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(PROCESS_CALL_COMPLETED_QUEUE, {
        retryLimit: 5,
        retryBackoff: true,
    });

    await fastify.pgBoss.work<ProcessCallCompletedJobData>(PROCESS_CALL_COMPLETED_QUEUE, async ([job]) => {
        await processCallCompletedHandler(fastify, job);
    });
}
