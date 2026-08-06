import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { supabaseAdmin } from '../src/lib/supabase.js';

vi.mock('../src/services/email.js', () => ({
    sendProspectSummaryEmail: vi.fn(),
}));

import { sendProspectSummaryEmail } from '../src/services/email.js';
import { sendProspectSummaryHandler, type SendProspectSummaryJobData } from '../src/jobs/send-prospect-summary.js';

const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

function buildFakeFastify(): FastifyInstance {
    return {
        supabaseAdmin,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as FastifyInstance;
}

function buildJob(leadId: string): Job<SendProspectSummaryJobData> {
    return { id: 'fake-job-id', data: { leadId } } as unknown as Job<SendProspectSummaryJobData>;
}

async function createLead(overrides: Record<string, unknown> = {}): Promise<string> {
    const { data, error } = await supabaseAdmin
        .from('leads')
        .insert({
            organization_id: REAL_ORG_ID,
            channel: 'voice',
            conversation_id: `send-prospect-summary-test:${Date.now()}:${Math.random().toString(36).slice(2)}`,
            full_name: 'Prospecto de Prueba',
            email: 'prospecto-prueba@example.invalid',
            business_name: 'Negocio de Prueba',
            needs_followup: true,
            ...overrides,
        })
        .select('id')
        .single();

    if (error || !data) {
        throw new Error(`No se pudo crear el lead de prueba: ${error?.message}`);
    }
    return data.id;
}

describe('4.3 — send-prospect-summary', () => {
    const createdLeadIds: string[] = [];

    afterEach(() => {
        vi.mocked(sendProspectSummaryEmail).mockReset();
    });

    afterAll(async () => {
        if (createdLeadIds.length > 0) {
            await supabaseAdmin.from('leads').delete().in('id', createdLeadIds);
        }
    });

    it('con correo y needs_followup=true (proxy de compromiso explícito), envía el resumen y marca prospect_summary_sent_at', async () => {
        const leadId = await createLead();
        createdLeadIds.push(leadId);

        vi.mocked(sendProspectSummaryEmail).mockResolvedValue({ data: { id: 'fake-email-id' } } as any);

        await sendProspectSummaryHandler(buildFakeFastify(), buildJob(leadId));

        expect(sendProspectSummaryEmail).toHaveBeenCalledTimes(1);
        expect(vi.mocked(sendProspectSummaryEmail).mock.calls[0][0]).toMatchObject({
            to: 'prospecto-prueba@example.invalid',
            prospectName: 'Prospecto de Prueba',
        });

        const { data: lead } = await supabaseAdmin.from('leads').select('prospect_summary_sent_at').eq('id', leadId).single();
        expect(lead?.prospect_summary_sent_at).not.toBeNull();
    });

    it('contraparte de rechazo: sin needs_followup (sin compromiso explícito), se omite', async () => {
        const leadId = await createLead({ needs_followup: false });
        createdLeadIds.push(leadId);

        vi.mocked(sendProspectSummaryEmail).mockResolvedValue({ data: { id: 'unused' } } as any);

        await sendProspectSummaryHandler(buildFakeFastify(), buildJob(leadId));

        expect(sendProspectSummaryEmail).not.toHaveBeenCalled();
    });

    it('sin correo (ni en el lead ni en el contacto), se omite aunque haya compromiso explícito', async () => {
        const leadId = await createLead({ email: null });
        createdLeadIds.push(leadId);

        vi.mocked(sendProspectSummaryEmail).mockResolvedValue({ data: { id: 'unused' } } as any);

        await sendProspectSummaryHandler(buildFakeFastify(), buildJob(leadId));

        expect(sendProspectSummaryEmail).not.toHaveBeenCalled();
    });

    it('idempotencia: un lead ya notificado no reenvía el resumen', async () => {
        const leadId = await createLead({ prospect_summary_sent_at: new Date().toISOString() });
        createdLeadIds.push(leadId);

        vi.mocked(sendProspectSummaryEmail).mockResolvedValue({ data: { id: 'unused' } } as any);

        await sendProspectSummaryHandler(buildFakeFastify(), buildJob(leadId));

        expect(sendProspectSummaryEmail).not.toHaveBeenCalled();
    });

    it('contacts.opted_out=true bloquea el envío aunque haya correo y compromiso explícito', async () => {
        const phone = `+52165${Math.floor(1000000 + Math.random() * 8999999)}`;
        const { data: contact, error: contactErr } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: REAL_ORG_ID,
                phone_e164: phone,
                email: 'contacto-opted-out@example.invalid',
                opted_out: true,
                opted_out_at: new Date().toISOString(),
            })
            .select('id')
            .single();

        if (contactErr || !contact) {
            throw new Error(`No se pudo crear el contacto de prueba: ${contactErr?.message}`);
        }

        try {
            const leadId = await createLead({ contact_id: contact.id, email: null });
            createdLeadIds.push(leadId);

            vi.mocked(sendProspectSummaryEmail).mockResolvedValue({ data: { id: 'unused' } } as any);

            await sendProspectSummaryHandler(buildFakeFastify(), buildJob(leadId));

            expect(sendProspectSummaryEmail).not.toHaveBeenCalled();
        } finally {
            await supabaseAdmin.from('contacts').delete().eq('id', contact.id);
        }
    });
});
