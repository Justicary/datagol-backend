import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setFeatureOverride, clearEntitlementsCache } from '../src/services/entitlements.js';
import { FEATURE_KEYS } from '../src/types/feature-taxonomy.js';

vi.mock('../src/services/email.js', () => ({
    sendHotLeadAlertEmail: vi.fn(),
}));

import { sendHotLeadAlertEmail } from '../src/services/email.js';
import { notifyHotLeadHandler, type NotifyHotLeadJobData } from '../src/jobs/notify-hot-lead.js';

// Organización real existente, plan 'starter' (sin hot_lead_alerts por
// defecto — ver plan_features). Ese es justo el estado que necesitamos para
// probar la ruta "feature deshabilitada, se omite" sin preparar nada extra.
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

function buildFakeFastify(): FastifyInstance {
    return {
        supabaseAdmin,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as FastifyInstance;
}

function buildJob(leadId: string): Job<NotifyHotLeadJobData> {
    return { id: 'fake-job-id', data: { leadId } } as unknown as Job<NotifyHotLeadJobData>;
}

async function createLead(overrides: Record<string, unknown> = {}): Promise<string> {
    const { data, error } = await supabaseAdmin
        .from('leads')
        .insert({
            organization_id: REAL_ORG_ID,
            channel: 'voice',
            conversation_id: `notify-hot-lead-test:${Date.now()}:${Math.random().toString(36).slice(2)}`,
            full_name: 'Prospecto de Prueba',
            contact_phone: '+525599999999',
            business_name: 'Negocio de Prueba',
            inquiry_reason: 'Cotización de prueba',
            temperature: 'caliente',
            booked_appointment: false,
            ...overrides,
        })
        .select('id')
        .single();

    if (error || !data) {
        throw new Error(`No se pudo crear el lead de prueba: ${error?.message}`);
    }
    return data.id;
}

describe('4.1 — notify-hot-lead', () => {
    const createdLeadIds: string[] = [];

    afterEach(() => {
        vi.mocked(sendHotLeadAlertEmail).mockReset();
    });

    afterAll(async () => {
        if (createdLeadIds.length > 0) {
            await supabaseAdmin.from('leads').delete().in('id', createdLeadIds);
        }
    });

    it('la organización sin la feature hot_lead_alerts (plan starter): se omite y no se envía correo', async () => {
        const leadId = await createLead();
        createdLeadIds.push(leadId);

        vi.mocked(sendHotLeadAlertEmail).mockResolvedValue({ data: { id: 'unused' } } as any);

        await notifyHotLeadHandler(buildFakeFastify(), buildJob(leadId));

        expect(sendHotLeadAlertEmail).not.toHaveBeenCalled();

        const { data: lead } = await supabaseAdmin.from('leads').select('hot_lead_notified_at').eq('id', leadId).single();
        expect(lead?.hot_lead_notified_at).toBeNull();
    });

    it('contraparte de éxito: con la feature habilitada, envía la alerta y marca hot_lead_notified_at', async () => {
        const result = await setFeatureOverride(REAL_ORG_ID, FEATURE_KEYS.HOT_LEAD_ALERTS, true, 'Prueba 4.1 notify-hot-lead');
        expect(result.success).toBe(true);

        try {
            const leadId = await createLead();
            createdLeadIds.push(leadId);

            vi.mocked(sendHotLeadAlertEmail).mockResolvedValue({ data: { id: 'fake-email-id' } } as any);

            await notifyHotLeadHandler(buildFakeFastify(), buildJob(leadId));

            expect(sendHotLeadAlertEmail).toHaveBeenCalledTimes(1);
            expect(vi.mocked(sendHotLeadAlertEmail).mock.calls[0][0]).toMatchObject({
                to: 'datagolmx@gmail.com',
                leadName: 'Prospecto de Prueba',
                leadPhone: '+525599999999',
            });

            const { data: lead } = await supabaseAdmin.from('leads').select('hot_lead_notified_at').eq('id', leadId).single();
            expect(lead?.hot_lead_notified_at).not.toBeNull();
        } finally {
            await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', FEATURE_KEYS.HOT_LEAD_ALERTS);
            clearEntitlementsCache(REAL_ORG_ID);
        }
    });

    it('idempotencia: un lead ya notificado no reenvía el correo', async () => {
        const result = await setFeatureOverride(REAL_ORG_ID, FEATURE_KEYS.HOT_LEAD_ALERTS, true, 'Prueba 4.1 idempotencia');
        expect(result.success).toBe(true);

        try {
            const leadId = await createLead({ hot_lead_notified_at: new Date().toISOString() });
            createdLeadIds.push(leadId);

            vi.mocked(sendHotLeadAlertEmail).mockResolvedValue({ data: { id: 'unused' } } as any);

            await notifyHotLeadHandler(buildFakeFastify(), buildJob(leadId));

            expect(sendHotLeadAlertEmail).not.toHaveBeenCalled();
        } finally {
            await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', FEATURE_KEYS.HOT_LEAD_ALERTS);
            clearEntitlementsCache(REAL_ORG_ID);
        }
    });

    it('la condición de disparo ya no aplica (booked_appointment=true entre encolado y ejecución): se omite', async () => {
        const result = await setFeatureOverride(REAL_ORG_ID, FEATURE_KEYS.HOT_LEAD_ALERTS, true, 'Prueba 4.1 condición cambiada');
        expect(result.success).toBe(true);

        try {
            const leadId = await createLead({ booked_appointment: true });
            createdLeadIds.push(leadId);

            vi.mocked(sendHotLeadAlertEmail).mockResolvedValue({ data: { id: 'unused' } } as any);

            await notifyHotLeadHandler(buildFakeFastify(), buildJob(leadId));

            expect(sendHotLeadAlertEmail).not.toHaveBeenCalled();
        } finally {
            await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', FEATURE_KEYS.HOT_LEAD_ALERTS);
            clearEntitlementsCache(REAL_ORG_ID);
        }
    });
});
