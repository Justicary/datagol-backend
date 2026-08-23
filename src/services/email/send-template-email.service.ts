import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';
import { validateAttachmentMagicBytes } from '../../lib/magic-bytes.js';
import { renderMarkdownLite } from '../../lib/markdown-lite.js';
import { EMAIL_TEMPLATES, EMAIL_TYPES, type OrganizationEmailSettings } from '../../types/email-templates.js';
import { deriveSafeEmailTheme } from '../email-theme.js';
import { renderEmail } from '../email-renderer.js';
import { loadContactsForSend } from './contact-recipients.service.js';
import { interpolateTemplateVariables } from './template-variables.js';
import { SEND_TEMPLATE_EMAIL_QUEUE } from '../../jobs/send-template-email.js';
import type { SendTemplateEmailBody, SendTemplateEmailAttachment } from '../../schemas/send-template-email.js';

/**
 * Orquesta el paso síncrono de `send-template-email`
 * (docs/tasks/send-template-email-backend.md): valida cuenta y adjuntos,
 * filtra contactos (LFPDPPP §11 — opted_out nunca recibe correo), renderiza
 * el HTML por contacto e inserta en `email_outbox` con `status: 'draft'`.
 * El envío SMTP real ocurre después, de forma asíncrona, en
 * `jobs/send-template-email.ts` — un job por `outboxId` nuevo, mismo patrón
 * "insertar rápido + encolar N jobs" que `sweep-weekly-reports.ts`.
 */

// Límite comercial combinado del doc de spec — no es el límite POR ARCHIVO
// de `magic-bytes.ts` (ese ya se aplica dentro de `validateAttachmentMagicBytes`
// a cada adjunto individual); este topa la SUMA de todos los adjuntos del envío.
const MAX_TEMPLATE_ATTACHMENTS_TOTAL_BYTES = 10 * 1024 * 1024;

export interface PrepareTemplateBatchSummary {
    totalRequested: number;
    queued: number;
    skippedOptedOut: number;
    skippedNoEmail: number;
    outboxIds: string[];
}

export type PrepareTemplateBatchResult =
    | { success: true; summary: PrepareTemplateBatchSummary }
    | { success: false; error: string; statusCode: 400 | 404 };

interface ValidatedAttachment {
    filename: string;
    contentType: string;
    contentBase64: string;
    sizeBytes: number;
}

function validateAttachments(attachments: SendTemplateEmailAttachment[] | undefined): { ok: true; attachments: ValidatedAttachment[] } | { ok: false; error: string } {
    if (!attachments || attachments.length === 0) {
        return { ok: true, attachments: [] };
    }

    let totalBytes = 0;
    const validated: ValidatedAttachment[] = [];

    for (const att of attachments) {
        const buffer = Buffer.from(att.contentBase64, 'base64');
        if (buffer.length !== att.sizeBytes) {
            return { ok: false, error: `El adjunto "${att.filename}" declara ${att.sizeBytes} bytes pero su contenido decodificado tiene ${buffer.length}.` };
        }

        const sniffed = validateAttachmentMagicBytes(buffer);
        if (!sniffed) {
            return { ok: false, error: `El adjunto "${att.filename}" no es un archivo PDF, DOCX, XLSX, PNG o JPEG válido (o excede el límite por archivo).` };
        }

        totalBytes += buffer.length;
        validated.push({ filename: att.filename, contentType: sniffed.mimeType, contentBase64: att.contentBase64, sizeBytes: buffer.length });
    }

    if (totalBytes > MAX_TEMPLATE_ATTACHMENTS_TOTAL_BYTES) {
        return { ok: false, error: `El tamaño combinado de los adjuntos (${(totalBytes / (1024 * 1024)).toFixed(2)} MB) excede el límite de 10 MB.` };
    }

    return { ok: true, attachments: validated };
}

async function insertOrReuseOutboxRow(params: {
    organizationId: string;
    emailAccountId: string;
    contactId: string;
    idempotencyKey: string;
    toAddress: string;
    subject: string;
    bodyText: string;
    bodyHtml: string;
    replyTo: string | null;
    attachments: ValidatedAttachment[] | null;
}): Promise<{ outboxId: string; isNew: boolean } | null> {
    const { data: inserted, error: insertErr } = await supabaseAdmin
        .from('email_outbox')
        .insert({
            organization_id: params.organizationId,
            email_account_id: params.emailAccountId,
            idempotency_key: params.idempotencyKey,
            to_addresses: [params.toAddress],
            subject: params.subject,
            body_text: params.bodyText,
            body_html: params.bodyHtml,
            contact_id: params.contactId,
            status: 'draft',
            reply_to: params.replyTo,
            attachments: params.attachments && params.attachments.length > 0 ? params.attachments : null,
        })
        .select('id')
        .single();

    if (!insertErr && inserted) {
        return { outboxId: inserted.id as string, isNew: true };
    }

    if (insertErr?.code === '23505') {
        const { data: existing } = await supabaseAdmin
            .from('email_outbox')
            .select('id')
            .eq('organization_id', params.organizationId)
            .eq('idempotency_key', params.idempotencyKey)
            .maybeSingle();
        if (existing) {
            return { outboxId: existing.id as string, isNew: false };
        }
    }

    logger.error(
        { err: insertErr, organizationId: params.organizationId, contactId: params.contactId },
        '[SendTemplateEmailService] No se pudo insertar fila de email_outbox'
    );
    return null;
}

export async function prepareTemplateBatch(
    fastify: FastifyInstance,
    organizationId: string,
    payload: SendTemplateEmailBody
): Promise<PrepareTemplateBatchResult> {
    const attachmentsResult = validateAttachments(payload.attachments);
    if (!attachmentsResult.ok) {
        return { success: false, error: attachmentsResult.error, statusCode: 400 };
    }

    const { data: account } = await supabaseAdmin
        .from('email_accounts')
        .select('id, status')
        .eq('id', payload.emailAccountId)
        .eq('organization_id', organizationId)
        .maybeSingle();

    if (!account) {
        return { success: false, error: 'El buzón indicado no existe o no pertenece a esta organización.', statusCode: 404 };
    }
    if (account.status !== 'active') {
        return { success: false, error: 'Este buzón no está activo; no se pueden despachar correos con esta cuenta.', statusCode: 400 };
    }

    const { data: org, error: orgErr } = await supabaseAdmin
        .from('organizations')
        .select('name, integration_settings')
        .eq('id', organizationId)
        .maybeSingle();

    if (orgErr || !org) {
        return { success: false, error: 'La organización no existe.', statusCode: 404 };
    }

    const settings = (org.integration_settings as Record<string, unknown> | null) ?? {};
    const safeTheme = deriveSafeEmailTheme(settings.theme);
    const emailConfig = (settings.email as OrganizationEmailSettings | undefined) ?? {};
    const effectiveTemplate = payload.template || emailConfig.template || EMAIL_TEMPLATES.PROFESIONAL;
    const effectiveReplyTo = payload.replyTo || emailConfig.replyTo || null;
    const organizationName = org.name || 'Datagol';

    const contacts = await loadContactsForSend(organizationId, payload.contactIds);
    const contactsById = new Map(contacts.map((c) => [c.id, c]));

    // Hash de contenido por-lote (mismo subject/bodyMarkdown para todos los
    // destinatarios) + hora — combinado con el contactId da la clave de
    // idempotencia compuesta que pide el doc de spec: un reintento del mismo
    // lote dentro de la misma hora no duplica el envío a un contacto, pero un
    // lote de contenido distinto sí puede alcanzar al mismo contacto de nuevo.
    const hourBucket = new Date().toISOString().slice(0, 13);
    const contentHash = crypto.createHash('sha256').update(`${payload.subject}\n${payload.bodyMarkdown}\n${hourBucket}`).digest('hex');

    let skippedOptedOut = 0;
    let skippedNoEmail = 0;
    const outboxIds: string[] = [];
    const newOutboxIds: string[] = [];

    for (const contactId of payload.contactIds) {
        const contact = contactsById.get(contactId);
        if (!contact) {
            // No pertenece a la organización o fue eliminado — mismo desenlace
            // observable que "sin email válido": no hay a quién enviarle.
            skippedNoEmail += 1;
            continue;
        }
        if (contact.optedOut) {
            skippedOptedOut += 1;
            continue;
        }
        if (!contact.email || contact.email.trim() === '') {
            skippedNoEmail += 1;
            continue;
        }

        const subject = interpolateTemplateVariables(payload.subject, {
            fullName: contact.fullName,
            businessName: contact.businessName,
            senderOrganizationName: organizationName,
        });
        const bodyMarkdown = interpolateTemplateVariables(payload.bodyMarkdown, {
            fullName: contact.fullName,
            businessName: contact.businessName,
            senderOrganizationName: organizationName,
        });
        const { html: bodyHtmlFragment, text: bodyTextFallback } = renderMarkdownLite(bodyMarkdown);

        const rendered = renderEmail(
            EMAIL_TYPES.CUSTOM_TEMPLATE_MESSAGE,
            { subject, bodyHtml: bodyHtmlFragment, bodyText: bodyTextFallback, businessName: organizationName },
            {
                templateId: effectiveTemplate,
                theme: safeTheme,
                logoUrl: emailConfig.logoUrl ?? null,
                footerText: emailConfig.footerText ?? null,
                replyTo: effectiveReplyTo,
            }
        );

        const idempotencyKey = `send-template:${organizationId}:${contactId}:${contentHash}`;

        const row = await insertOrReuseOutboxRow({
            organizationId,
            emailAccountId: payload.emailAccountId,
            contactId,
            idempotencyKey,
            toAddress: contact.email,
            subject: rendered.subject,
            bodyText: rendered.text,
            bodyHtml: rendered.html,
            replyTo: effectiveReplyTo,
            attachments: attachmentsResult.attachments,
        });

        if (!row) {
            continue; // Error de infraestructura ya registrado en insertOrReuseOutboxRow; no cuenta como queued.
        }

        outboxIds.push(row.outboxId);
        if (row.isNew) {
            newOutboxIds.push(row.outboxId);
        }
    }

    for (const outboxId of newOutboxIds) {
        await fastify.pgBoss.send(SEND_TEMPLATE_EMAIL_QUEUE, { outboxId });
    }

    return {
        success: true,
        summary: {
            totalRequested: payload.contactIds.length,
            queued: outboxIds.length,
            skippedOptedOut,
            skippedNoEmail,
            outboxIds,
        },
    };
}
