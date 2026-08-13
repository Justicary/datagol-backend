import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setFeatureOverride, clearEntitlementsCache } from '../src/services/entitlements.js';
import { FEATURE_KEYS } from '../src/types/feature-taxonomy.js';

vi.mock('../src/services/email.js', () => ({
    sendCallSummaryEmail: vi.fn(),
}));

import { sendCallSummaryEmail } from '../src/services/email.js';
import { sendCallSummaryHandler, type SendCallSummaryJobData } from '../src/jobs/send-call-summary.js';

// Organización real existente, plan 'starter'. El plan starter tiene
// email_summaries con enabled:false en plan_features — la ruta de éxito
// necesita un override explícito para concederla (ver beforeAll del primer
// test), igual que la ruta de rechazo usa un override explícito para negarla.
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

function buildFakeFastify(): FastifyInstance {
    return {
        supabaseAdmin,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as FastifyInstance;
}

function buildJob(callLogId: string): Job<SendCallSummaryJobData> {
    return { id: 'fake-job-id', data: { callLogId } } as unknown as Job<SendCallSummaryJobData>;
}

async function createCallLog(overrides: Record<string, unknown> = {}): Promise<string> {
    const { data, error } = await supabaseAdmin
        .from('call_logs')
        .insert({
            organization_id: REAL_ORG_ID,
            provider_call_id: `send-call-summary-test:${Date.now()}:${Math.random().toString(36).slice(2)}`,
            caller_phone: '+525599999999',
            duration_seconds: 185,
            transcript: 'Cliente: Hola.\nAgente: ¿En qué te ayudo?',
            summary: 'El cliente pidió información de precios.',
            ...overrides,
        })
        .select('id')
        .single();

    if (error || !data) {
        throw new Error(`No se pudo crear el call_log de prueba: ${error?.message}`);
    }
    return data.id;
}

describe('4.2 — send-call-summary', () => {
    const createdCallLogIds: string[] = [];

    afterEach(() => {
        vi.mocked(sendCallSummaryEmail).mockReset();
    });

    afterAll(async () => {
        if (createdCallLogIds.length > 0) {
            await supabaseAdmin.from('call_logs').delete().in('id', createdCallLogIds);
        }
    });

    it('con la feature email_summaries habilitada (por override; el plan starter la tiene apagada), envía la minuta y marca call_summary_sent_at', async () => {
        const overrideResult = await setFeatureOverride(REAL_ORG_ID, FEATURE_KEYS.EMAIL_SUMMARIES, true, 'Prueba 4.2 ruta de éxito');
        expect(overrideResult.success).toBe(true);

        try {
            const callLogId = await createCallLog();
            createdCallLogIds.push(callLogId);

            vi.mocked(sendCallSummaryEmail).mockResolvedValue({ data: { id: 'fake-email-id' } } as any);

            await sendCallSummaryHandler(buildFakeFastify(), buildJob(callLogId));

            expect(sendCallSummaryEmail).toHaveBeenCalledTimes(1);
            expect(vi.mocked(sendCallSummaryEmail).mock.calls[0][0]).toMatchObject({
                to: 'datagolmx@gmail.com',
                callerPhone: '+525599999999',
                summary: 'El cliente pidió información de precios.',
            });

            const { data: callLog } = await supabaseAdmin.from('call_logs').select('call_summary_sent_at').eq('id', callLogId).single();
            expect(callLog?.call_summary_sent_at).not.toBeNull();
        } finally {
            await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', FEATURE_KEYS.EMAIL_SUMMARIES);
            clearEntitlementsCache(REAL_ORG_ID);
        }
    });

    it('contraparte de rechazo: sin la feature email_summaries, se omite y no se envía correo', async () => {
        // Override explícito deshabilitando la feature para este org, aunque el
        // plan starter la conceda por defecto (precedencia: override > plan).
        const result = await setFeatureOverride(REAL_ORG_ID, FEATURE_KEYS.EMAIL_SUMMARIES, false, 'Prueba 4.2 feature deshabilitada');
        expect(result.success).toBe(true);

        try {
            const callLogId = await createCallLog();
            createdCallLogIds.push(callLogId);

            vi.mocked(sendCallSummaryEmail).mockResolvedValue({ data: { id: 'unused' } } as any);

            await sendCallSummaryHandler(buildFakeFastify(), buildJob(callLogId));

            expect(sendCallSummaryEmail).not.toHaveBeenCalled();

            const { data: callLog } = await supabaseAdmin.from('call_logs').select('call_summary_sent_at').eq('id', callLogId).single();
            expect(callLog?.call_summary_sent_at).toBeNull();
        } finally {
            await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', FEATURE_KEYS.EMAIL_SUMMARIES);
            clearEntitlementsCache(REAL_ORG_ID);
        }
    });

    it('idempotencia: un call_log ya notificado no reenvía la minuta', async () => {
        const callLogId = await createCallLog({ call_summary_sent_at: new Date().toISOString() });
        createdCallLogIds.push(callLogId);

        vi.mocked(sendCallSummaryEmail).mockResolvedValue({ data: { id: 'unused' } } as any);

        await sendCallSummaryHandler(buildFakeFastify(), buildJob(callLogId));

        expect(sendCallSummaryEmail).not.toHaveBeenCalled();
    });
});
