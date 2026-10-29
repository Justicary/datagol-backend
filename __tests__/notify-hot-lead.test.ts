import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { createTestPlan, deleteTestPlan } from './helpers/test-plan.js';
import { deleteTestOrganizations } from './helpers/test-data-sweeper.js';
import { setFeatureOverride, clearEntitlementsCache } from '../src/services/entitlements.js';
import { FEATURE_KEYS } from '../src/types/feature-taxonomy.js';

vi.mock('../src/services/email.js', () => ({
    sendHotLeadAlertEmail: vi.fn(),
}));

import { sendHotLeadAlertEmail } from '../src/services/email.js';
import { notifyHotLeadHandler, type NotifyHotLeadJobData } from '../src/jobs/notify-hot-lead.js';

// Organización y plan propios de la suite. El plan no incluye hot_lead_alerts: la
// ruta de éxito la concede con un override explícito sobre ESTA organización.
// Nunca se usa una organización real: borrar sus overrides en el finally
// borraría las activaciones del superadmin.
let ORG_ID: string;
let TEST_PLAN_KEY: string;

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
            organization_id: ORG_ID,
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

    beforeAll(async () => {
        TEST_PLAN_KEY = await createTestPlan(supabaseAdmin);
        const { data: org, error } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org (notify-hot-lead.test.ts)',
                email: `org-notify-hot-lead-${crypto.randomUUID()}@example.invalid`,
                plan_key: TEST_PLAN_KEY,
                status: 'active',
            })
            .select('id')
            .single();
        if (error || !org) throw new Error(`No se pudo crear la organización de prueba: ${error?.message}`);
        ORG_ID = org.id;
    });

    afterEach(() => {
        vi.mocked(sendHotLeadAlertEmail).mockReset();
    });

    afterAll(async () => {
        if (createdLeadIds.length > 0) {
            await supabaseAdmin.from('leads').delete().in('id', createdLeadIds);
        }
        // feature_audit_log (append-only) bloquea el DELETE simple: el helper
        // recurre a admin_delete_organizations_cascade y falla si no la borra.
        await deleteTestOrganizations(supabaseAdmin, [ORG_ID]);
        await deleteTestPlan(supabaseAdmin, TEST_PLAN_KEY);
    });

    it('la organización sin la feature hot_lead_alerts (su plan no la incluye): se omite y no se envía correo', async () => {
        const leadId = await createLead();
        createdLeadIds.push(leadId);

        vi.mocked(sendHotLeadAlertEmail).mockResolvedValue({ data: { id: 'unused' } } as any);

        await notifyHotLeadHandler(buildFakeFastify(), buildJob(leadId));

        expect(sendHotLeadAlertEmail).not.toHaveBeenCalled();

        const { data: lead } = await supabaseAdmin.from('leads').select('hot_lead_notified_at').eq('id', leadId).single();
        expect(lead?.hot_lead_notified_at).toBeNull();
    });

    it('contraparte de éxito: con la feature habilitada, envía la alerta y marca hot_lead_notified_at', async () => {
        const result = await setFeatureOverride(ORG_ID, FEATURE_KEYS.HOT_LEAD_ALERTS, true, 'Prueba 4.1 notify-hot-lead');
        expect(result.success).toBe(true);

        try {
            const leadId = await createLead();
            createdLeadIds.push(leadId);

            vi.mocked(sendHotLeadAlertEmail).mockResolvedValue({ data: { id: 'fake-email-id' } } as any);

            await notifyHotLeadHandler(buildFakeFastify(), buildJob(leadId));

            expect(sendHotLeadAlertEmail).toHaveBeenCalledTimes(1);
            expect(vi.mocked(sendHotLeadAlertEmail).mock.calls[0][0]).toMatchObject({
                to: expect.stringMatching(/@/),
                leadName: 'Prospecto de Prueba',
                leadPhone: '+525599999999',
            });

            const { data: lead } = await supabaseAdmin.from('leads').select('hot_lead_notified_at').eq('id', leadId).single();
            expect(lead?.hot_lead_notified_at).not.toBeNull();
        } finally {
            await supabaseAdmin.from('organization_features').delete().eq('organization_id', ORG_ID).eq('feature_key', FEATURE_KEYS.HOT_LEAD_ALERTS);
            clearEntitlementsCache(ORG_ID);
        }
    });

    it('idempotencia: un lead ya notificado no reenvía el correo', async () => {
        const result = await setFeatureOverride(ORG_ID, FEATURE_KEYS.HOT_LEAD_ALERTS, true, 'Prueba 4.1 idempotencia');
        expect(result.success).toBe(true);

        try {
            const leadId = await createLead({ hot_lead_notified_at: new Date().toISOString() });
            createdLeadIds.push(leadId);

            vi.mocked(sendHotLeadAlertEmail).mockResolvedValue({ data: { id: 'unused' } } as any);

            await notifyHotLeadHandler(buildFakeFastify(), buildJob(leadId));

            expect(sendHotLeadAlertEmail).not.toHaveBeenCalled();
        } finally {
            await supabaseAdmin.from('organization_features').delete().eq('organization_id', ORG_ID).eq('feature_key', FEATURE_KEYS.HOT_LEAD_ALERTS);
            clearEntitlementsCache(ORG_ID);
        }
    });

    it('la condición de disparo ya no aplica (booked_appointment=true entre encolado y ejecución): se omite', async () => {
        const result = await setFeatureOverride(ORG_ID, FEATURE_KEYS.HOT_LEAD_ALERTS, true, 'Prueba 4.1 condición cambiada');
        expect(result.success).toBe(true);

        try {
            const leadId = await createLead({ booked_appointment: true });
            createdLeadIds.push(leadId);

            vi.mocked(sendHotLeadAlertEmail).mockResolvedValue({ data: { id: 'unused' } } as any);

            await notifyHotLeadHandler(buildFakeFastify(), buildJob(leadId));

            expect(sendHotLeadAlertEmail).not.toHaveBeenCalled();
        } finally {
            await supabaseAdmin.from('organization_features').delete().eq('organization_id', ORG_ID).eq('feature_key', FEATURE_KEYS.HOT_LEAD_ALERTS);
            clearEntitlementsCache(ORG_ID);
        }
    });
});
