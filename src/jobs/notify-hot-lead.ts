import { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { getOrganizationFeatures } from '../services/entitlements.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { LEAD_TEMPERATURES } from '../types/lead-enums.js';
import { sendHotLeadAlertEmail } from '../services/email.js';

export const NOTIFY_HOT_LEAD_QUEUE = 'notify-hot-lead';

export interface NotifyHotLeadJobData {
    leadId: string;
}

interface LeadRow {
    id: string;
    organization_id: string;
    full_name: string | null;
    contact_phone: string | null;
    business_name: string | null;
    inquiry_reason: string | null;
    followup_notes: string | null;
    temperature: string | null;
    booked_appointment: boolean;
    hot_lead_notified_at: string | null;
    contacts: { full_name: string | null; phone_e164: string | null } | null;
}

/**
 * Fase 4.1 — Notifica al negocio de un prospecto caliente sin cita agendada.
 * **Este job es el producto**: un prospecto caliente que colgó sin agendar es
 * exactamente donde el negocio debe intervenir en minutos, no al día
 * siguiente (objetivo: entrega en menos de un minuto tras terminar la
 * llamada — ver `priority` alto al encolar en process-call-completed.ts).
 *
 * La feature `hot_lead_alerts` se verifica AQUÍ, justo antes de enviar el
 * efecto — nunca antes de encolar (AGENTS.md §16).
 */
export async function notifyHotLeadHandler(fastify: FastifyInstance, job: Job<NotifyHotLeadJobData>): Promise<void> {
    const { leadId } = job.data;

    const { data: lead, error: fetchError } = await fastify.supabaseAdmin
        .from('leads')
        .select(
            'id, organization_id, full_name, contact_phone, business_name, inquiry_reason, followup_notes, temperature, booked_appointment, hot_lead_notified_at, contacts(full_name, phone_e164)'
        )
        .eq('id', leadId)
        .single<LeadRow>();

    if (fetchError || !lead) {
        throw new Error(`No se encontró leads.id=${leadId}: ${fetchError?.message ?? 'sin datos'}`);
    }

    if (lead.hot_lead_notified_at) {
        // Ya notificado en una ejecución previa (reintento de pg-boss); no reenviar.
        return;
    }

    // Re-verificar la condición de disparo: pudo haber cambiado entre el
    // encolado y la ejecución (p. ej. el negocio ya agendó la cita).
    if (lead.temperature !== LEAD_TEMPERATURES.CALIENTE || lead.booked_appointment) {
        fastify.log.info(
            { leadId, temperature: lead.temperature, bookedAppointment: lead.booked_appointment },
            'notify-hot-lead: la condición de disparo ya no aplica, se omite'
        );
        return;
    }

    const features = await getOrganizationFeatures(lead.organization_id);
    if (!features.has(FEATURE_KEYS.HOT_LEAD_ALERTS)) {
        fastify.log.info(
            { leadId, organizationId: lead.organization_id },
            'notify-hot-lead: la organización no tiene la feature hot_lead_alerts habilitada, se omite'
        );
        return;
    }

    const { data: org, error: orgError } = await fastify.supabaseAdmin
        .from('organizations')
        .select('email')
        .eq('id', lead.organization_id)
        .single();

    if (orgError || !org?.email) {
        throw new Error(`organizations.id=${lead.organization_id} sin email de notificación: ${orgError?.message ?? 'email vacío'}`);
    }

    const response = await sendHotLeadAlertEmail({
        to: org.email,
        leadName: lead.full_name ?? lead.contacts?.full_name ?? null,
        leadPhone: lead.contact_phone ?? lead.contacts?.phone_e164 ?? null,
        businessName: lead.business_name,
        inquiryReason: lead.inquiry_reason,
        followupNotes: lead.followup_notes,
    });

    if (!response) {
        throw new Error(`No se pudo enviar la alerta de prospecto caliente para leads.id=${leadId}`);
    }

    const { error: updateError } = await fastify.supabaseAdmin
        .from('leads')
        .update({ hot_lead_notified_at: new Date().toISOString() })
        .eq('id', leadId)
        .is('hot_lead_notified_at', null);

    if (updateError) {
        fastify.log.error({ err: updateError, leadId }, 'notify-hot-lead: correo enviado pero falló marcar hot_lead_notified_at');
    }

    fastify.log.info({ leadId, organizationId: lead.organization_id }, 'notify-hot-lead: alerta entregada correctamente');
}

/**
 * Registra la cola y el worker de pg-boss para `notify-hot-lead`.
 */
export async function registerNotifyHotLeadWorker(fastify: FastifyInstance): Promise<void> {
    await fastify.pgBoss.createQueue(NOTIFY_HOT_LEAD_QUEUE, {
        retryLimit: 5,
        retryBackoff: true,
    });

    await fastify.pgBoss.work<NotifyHotLeadJobData>(NOTIFY_HOT_LEAD_QUEUE, async ([job]) => {
        await notifyHotLeadHandler(fastify, job);
    });
}
