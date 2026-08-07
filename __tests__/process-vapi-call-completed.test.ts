import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { SEND_CALL_SUMMARY_QUEUE } from '../src/jobs/send-call-summary.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

const createCompletionMock = vi.fn();

vi.mock('openai', () => ({
    default: class OpenAI {
        chat = { completions: { create: createCompletionMock } };
    },
}));

// Import dinámico DESPUÉS del mock de 'openai' — el mock de vi.mock('openai', ...)
// se hoistea automáticamente por Vitest antes de cualquier import estático,
// así que un import estático normal también sería seguro, pero se mantiene
// explícito para dejar clara la dependencia del orden.
const { processVapiCallCompletedHandler } = await import('../src/jobs/process-vapi-call-completed.js');
type ProcessVapiCallCompletedJobData = { callLogId: string };

function buildFakeFastify() {
    const sendSpy = vi.fn().mockResolvedValue('fake-pgboss-job-id');
    const fastify = {
        supabaseAdmin,
        pgBoss: { send: sendSpy },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as FastifyInstance & { pgBoss: { send: typeof sendSpy } };
    return { fastify, sendSpy };
}

function buildJob(callLogId: string): Job<ProcessVapiCallCompletedJobData> {
    return { id: 'fake-job-id', data: { callLogId } } as unknown as Job<ProcessVapiCallCompletedJobData>;
}

async function insertCallLog(fields: Partial<Record<string, unknown>>): Promise<string> {
    const { data, error } = await supabaseAdmin
        .from('call_logs')
        .insert({
            organization_id: REAL_ORG_ID,
            provider_call_id: `vapi-test:${Date.now()}:${Math.random().toString(36).slice(2)}`,
            status: 'completed',
            ...fields,
        })
        .select('id')
        .single();

    if (error || !data) {
        throw new Error(`No se pudo crear call_logs de prueba: ${error?.message}`);
    }
    return data.id;
}

describe('process-vapi-call-completed', () => {
    const createdCallLogIds: string[] = [];

    afterEach(async () => {
        for (const id of createdCallLogIds) {
            await supabaseAdmin.from('call_logs').delete().eq('id', id);
        }
        createdCallLogIds.length = 0;
        createCompletionMock.mockReset();
    });

    it('lanza excepción si call_logs.id no existe', async () => {
        const { fastify } = buildFakeFastify();
        await expect(
            processVapiCallCompletedHandler(fastify, buildJob('00000000-0000-0000-0000-000000000000'))
        ).rejects.toThrow(/No se encontró call_logs/);
    });

    it('sin transcripción: no llama a OpenAI, conserva el resumen original y sentimiento neutral por defecto', async () => {
        const callLogId = await insertCallLog({ transcript: null, summary: 'Resumen original de Vapi' });
        createdCallLogIds.push(callLogId);

        const { fastify, sendSpy } = buildFakeFastify();
        await processVapiCallCompletedHandler(fastify, buildJob(callLogId));

        expect(createCompletionMock).not.toHaveBeenCalled();

        const { data: row } = await supabaseAdmin.from('call_logs').select('summary, sentiment').eq('id', callLogId).single();
        expect(row?.summary).toBe('Resumen original de Vapi');
        expect(row?.sentiment).toBe('neutral');
        expect(sendSpy).toHaveBeenCalledWith(SEND_CALL_SUMMARY_QUEUE, { callLogId });
    });

    it('con transcripción: usa el análisis de gpt-4o-mini para enriquecer summary y sentiment', async () => {
        const callLogId = await insertCallLog({
            transcript: 'Cliente: Hola, quiero agendar una cita.\nAgente: Claro, ¿qué día te acomoda?',
            summary: 'Resumen genérico de Vapi',
        });
        createdCallLogIds.push(callLogId);

        createCompletionMock.mockResolvedValue({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            summary: 'Cliente quiere agendar una cita.',
                            sentiment: 'positivo',
                            customer_address: null,
                        }),
                    },
                },
            ],
        });

        const { fastify, sendSpy } = buildFakeFastify();
        await processVapiCallCompletedHandler(fastify, buildJob(callLogId));

        expect(createCompletionMock).toHaveBeenCalledTimes(1);

        const { data: row } = await supabaseAdmin.from('call_logs').select('summary, sentiment').eq('id', callLogId).single();
        expect(row?.summary).toBe('Cliente quiere agendar una cita.');
        expect(row?.sentiment).toBe('positivo');
        expect(sendSpy).toHaveBeenCalledWith(SEND_CALL_SUMMARY_QUEUE, { callLogId });
    });

    it('agrega la ubicación identificada al resumen cuando el análisis la incluye', async () => {
        const callLogId = await insertCallLog({
            transcript: 'Cliente: Vivo en Av. Reforma 123, CDMX.',
            summary: 'Resumen genérico',
        });
        createdCallLogIds.push(callLogId);

        createCompletionMock.mockResolvedValue({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            summary: 'Cliente proporcionó su dirección.',
                            sentiment: 'neutral',
                            customer_address: 'Av. Reforma 123',
                            customer_city: 'CDMX',
                            customer_state: null,
                            customer_zip: null,
                        }),
                    },
                },
            ],
        });

        const { fastify } = buildFakeFastify();
        await processVapiCallCompletedHandler(fastify, buildJob(callLogId));

        const { data: row } = await supabaseAdmin.from('call_logs').select('summary').eq('id', callLogId).single();
        expect(row?.summary).toContain('Cliente proporcionó su dirección.');
        expect(row?.summary).toContain('📍 Ubicación identificada: Av. Reforma 123, CDMX');
    });

    it('contraparte de rechazo: si OpenAI falla (cuota agotada), no lanza excepción y conserva el resumen original', async () => {
        const callLogId = await insertCallLog({
            transcript: 'Cliente: Hola.',
            summary: 'Resumen original de Vapi',
        });
        createdCallLogIds.push(callLogId);

        const quotaError = Object.assign(new Error('You exceeded your current quota'), { status: 429 });
        createCompletionMock.mockRejectedValue(quotaError);

        const { fastify, sendSpy } = buildFakeFastify();
        await expect(processVapiCallCompletedHandler(fastify, buildJob(callLogId))).resolves.toBeUndefined();

        const { data: row } = await supabaseAdmin.from('call_logs').select('summary, sentiment').eq('id', callLogId).single();
        expect(row?.summary).toBe('Resumen original de Vapi');
        expect(row?.sentiment).toBe('neutral');
        // La minuta se sigue encolando: el resumen de Vapi ya es utilizable
        // aunque el reanálisis con OpenAI haya fallado.
        expect(sendSpy).toHaveBeenCalledWith(SEND_CALL_SUMMARY_QUEUE, { callLogId });
    });

    it('sin organization_id: no encola la minuta por correo (no hay a quién notificar)', async () => {
        const callLogId = await insertCallLog({ organization_id: null, transcript: null, summary: 'Resumen widget' });
        createdCallLogIds.push(callLogId);

        const { fastify, sendSpy } = buildFakeFastify();
        await processVapiCallCompletedHandler(fastify, buildJob(callLogId));

        expect(sendSpy).not.toHaveBeenCalled();
    });
});
