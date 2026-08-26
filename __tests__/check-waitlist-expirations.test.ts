import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { checkWaitlistExpirationsHandler } from '../src/jobs/check-waitlist-expirations.js';
import { EVALUATE_WAITLIST_FOR_SLOT_QUEUE } from '../src/jobs/evaluate-waitlist-for-slot.js';
import { WAITLIST_STATUSES } from '../src/types/waitlist.js';

function buildFakeFastify(pgBossSendSpy: ReturnType<typeof vi.fn>): FastifyInstance {
    return {
        supabaseAdmin,
        pgBoss: { send: pgBossSendSpy },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as FastifyInstance;
}

describe('jobs/check-waitlist-expirations', () => {
    let orgId: string;
    const createdWaitlistIds: string[] = [];

    beforeAll(async () => {
        const { data: org, error } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org (check-waitlist-expirations.test.ts)',
                email: `org-check-waitlist-expirations-${Date.now()}@example.invalid`,
                status: 'active',
            })
            .select('id')
            .single();
        if (error || !org) throw new Error(`No se pudo crear organización de prueba: ${error?.message}`);
        orgId = org.id;
    });

    afterAll(async () => {
        if (createdWaitlistIds.length) {
            await supabaseAdmin.from('appointment_waitlist').delete().in('id', createdWaitlistIds);
        }
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
    });

    async function createWaitlistRow(overrides: Record<string, unknown> = {}) {
        const slotStart = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
        const slotEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString();
        const { data, error } = await supabaseAdmin
            .from('appointment_waitlist')
            .insert({
                organization_id: orgId,
                customer_name: 'Cliente Expiración',
                customer_phone: '+525599992222',
                preferred_date_start: slotStart.slice(0, 10),
                preferred_date_end: slotStart.slice(0, 10),
                status: WAITLIST_STATUSES.OFERTADA,
                offer_token_hash: crypto.randomBytes(32).toString('hex'),
                offered_slot_start: slotStart,
                offered_slot_end: slotEnd,
                ...overrides,
            })
            .select('id')
            .single();
        if (error || !data) throw new Error(`No se pudo crear oferta de prueba: ${error?.message}`);
        createdWaitlistIds.push(data.id);
        return { id: data.id as string, slotStart, slotEnd };
    }

    it('expira una oferta vencida y encola la promoción del siguiente candidato', async () => {
        const { id, slotStart, slotEnd } = await createWaitlistRow({
            offer_expires_at: new Date(Date.now() - 60_000).toISOString(),
        });
        const pgBossSendSpy = vi.fn().mockResolvedValue('job-id');

        await checkWaitlistExpirationsHandler(buildFakeFastify(pgBossSendSpy));

        const { data: row } = await supabaseAdmin.from('appointment_waitlist').select('status').eq('id', id).single();
        expect(row?.status).toBe(WAITLIST_STATUSES.EXPIRADA);

        const call = pgBossSendSpy.mock.calls.find((c) => c[1]?.organizationId === orgId && new Date(c[1].slotStartTime).getTime() === new Date(slotStart).getTime());
        expect(call).toBeDefined();
        expect(call![0]).toBe(EVALUATE_WAITLIST_FOR_SLOT_QUEUE);
        expect(new Date(call![1].slotEndTime).getTime()).toBe(new Date(slotEnd).getTime());
    });

    it('no toca una oferta todavía vigente', async () => {
        const { id } = await createWaitlistRow({
            offer_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        });
        const pgBossSendSpy = vi.fn().mockResolvedValue('job-id');

        await checkWaitlistExpirationsHandler(buildFakeFastify(pgBossSendSpy));

        const { data: row } = await supabaseAdmin.from('appointment_waitlist').select('status').eq('id', id).single();
        expect(row?.status).toBe(WAITLIST_STATUSES.OFERTADA);
        expect(pgBossSendSpy.mock.calls.some((c) => c[1]?.organizationId === orgId)).toBe(false);
    });

    it('no toca una fila que ya no está en estado ofertada aunque su offer_expires_at esté vencido', async () => {
        const { id } = await createWaitlistRow({
            status: WAITLIST_STATUSES.CONFIRMADA,
            offer_expires_at: new Date(Date.now() - 60_000).toISOString(),
        });
        const pgBossSendSpy = vi.fn().mockResolvedValue('job-id');

        await checkWaitlistExpirationsHandler(buildFakeFastify(pgBossSendSpy));

        const { data: row } = await supabaseAdmin.from('appointment_waitlist').select('status').eq('id', id).single();
        expect(row?.status).toBe(WAITLIST_STATUSES.CONFIRMADA);
    });
});
