import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { sendProspectSummaryEmail } from '../services/email.js';

export const SEND_PROSPECT_SUMMARY_QUEUE = 'send-prospect-summary';

export interface SendProspectSummaryJobData {
    leadId: string;
}

interface LeadRow {
    id: string;
    organization_id: string;
    full_name: string | null;
    email: string | null;
    business_name: string | null;
    followup_notes: string | null;
    needs_followup: boolean;
    prospect_summary_sent_at: string | null;
    contacts: { email: string | null; opted_out: boolean } | null;
    call_logs: { summary: string | null } | null;
}

/**
 * Fase 4.3 — Resumen de cortesía enviado al propio prospecto. Solo se envía
 * si dejó correo y hubo un compromiso explícito de enviarle algo.
 *
 * Nota de alcance: el agente de ElevenLabs configurado hoy no captura una
 * señal dedicada de "prometí enviarte algo" en `data_collection_results`
 * (ver call-payload-mapper.ts) — `needs_followup` (`requiere_seguimiento`)
 * es la señal booleana más cercana y se usa como proxy documentado. Cuando
 * el agente capture una señal dedicada, este job debe migrarse a esa señal.
 *
 * El email autoritativo sigue el mismo COALESCE que la vista
 * `v_hot_leads_pending`: el de este lead primero, el histórico del contacto
 * después. `contacts.opted_out` se verifica siempre que exista un contacto
 * — un lead sin contact_id (p. ej. widget web sin teléfono válido) no tiene
 * relación de opt-out que violar.
 */
export async function sendProspectSummaryHandler(fastify: FastifyInstance, job: Job<SendProspectSummaryJobData>): Promise<void> {
    const { leadId } = job.data;

    const { data: lead, error: fetchError } = await fastify.supabaseAdmin
        .from('leads')
        .select(
            'id, organization_id, full_name, email, business_name, followup_notes, needs_followup, prospect_summary_sent_at, contacts(email, opted_out), call_logs(summary)'
        )
        .eq('id', leadId)
        .single<LeadRow>();

    if (fetchError || !lead) {
        throw new Error(`No se encontró leads.id=${leadId}: ${fetchError?.message ?? 'sin datos'}`);
    }

    if (lead.prospect_summary_sent_at) {
        // Ya enviado en una ejecución previa (reintento de pg-boss); no reenviar.
        return;
    }

    // Proxy documentado: no existe una key de data_collection_results
    // dedicada a "compromiso explícito de enviar algo" en el agente actual.
    // needs_followup es la señal booleana más cercana.
    if (!lead.needs_followup) {
        fastify.log.info({ leadId }, 'send-prospect-summary: sin compromiso explícito de seguimiento, se omite');
        return;
    }

    if (lead.contacts?.opted_out === true) {
        fastify.log.info({ leadId }, 'send-prospect-summary: el contacto está opted_out, se omite');
        return;
    }

    const prospectEmail = lead.email || lead.contacts?.email || null;
    if (!prospectEmail) {
        fastify.log.info({ leadId }, 'send-prospect-summary: el prospecto no dejó correo, se omite');
        return;
    }

    const response = await sendProspectSummaryEmail({
        organizationId: lead.organization_id,
        to: prospectEmail,
        prospectName: lead.full_name,
        businessName: lead.business_name,
        summary: lead.call_logs?.summary ?? null,
        followupNotes: lead.followup_notes,
    });

    if (!response) {
        throw new Error(`No se pudo enviar el resumen al prospecto para leads.id=${leadId}`);
    }

    const { error: updateError } = await fastify.supabaseAdmin
        .from('leads')
        .update({ prospect_summary_sent_at: new Date().toISOString() })
        .eq('id', leadId)
        .is('prospect_summary_sent_at', null);

    if (updateError) {
        fastify.log.error({ err: updateError, leadId }, 'send-prospect-summary: correo enviado pero falló marcar prospect_summary_sent_at');
    }

    fastify.log.info({ leadId, organizationId: lead.organization_id }, 'send-prospect-summary: resumen entregado correctamente');
}

/**
 * Registra la cola y el worker de pg-boss para `send-prospect-summary`.
 */
export async function registerSendProspectSummaryWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(SEND_PROSPECT_SUMMARY_QUEUE, {
        retryLimit: 5,
        retryBackoff: true,
    });

    await fastify.pgBoss.work<SendProspectSummaryJobData>(SEND_PROSPECT_SUMMARY_QUEUE, async ([job]) => {
        await sendProspectSummaryHandler(fastify, job);
    });
}
