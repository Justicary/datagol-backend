import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { APPOINTMENT_STATUSES } from '../src/types/appointment-status.js';

vi.mock('../src/services/email.js', () => ({
    sendPendingOutcomeReminderEmail: vi.fn(),
}));

import { sendPendingOutcomeReminderEmail } from '../src/services/email.js';
import { notifyPendingOutcomesHandler } from '../src/jobs/notify-pending-outcomes.js';

function buildFakeFastify(): FastifyInstance {
    return { supabaseAdmin, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as FastifyInstance;
}

function daysAgo(n: number): string {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// La organización dedicada se aísla, pero notifyPendingOutcomesHandler
// recorre TODAS las organizaciones con citas pendientes en la base
// compartida de pruebas — se filtra por organizationId en vez de asumir
// una sola llamada global, para no acoplar el test a datos de otros suites.
function callsForOrg(orgId: string) {
    return vi.mocked(sendPendingOutcomeReminderEmail).mock.calls.filter(([params]) => params.organizationId === orgId);
}

async function createOrg(withEmail = true): Promise<string> {
    // organizations.email es NOT NULL — "sin email de notificación" se
    // simula con cadena vacía, que el handler trata igual que ausente
    // (`if (!org?.email)`).
    const { data, error } = await supabaseAdmin
        .from('organizations')
        .insert({
            name: 'Org Pruebas notify-pending-outcomes',
            email: withEmail ? `test-notify-pending-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid` : '',
        })
        .select('id')
        .single();
    if (error || !data) throw new Error(`No se pudo crear la organización dedicada: ${error?.message}`);
    return data.id;
}

async function createPastAppointment(orgId: string, startTimeIso: string): Promise<string> {
    const { data, error } = await supabaseAdmin
        .from('appointments')
        .insert({
            organization_id: orgId,
            customer_name: 'Prospecto Sin Desenlace',
            start_time: startTimeIso,
            end_time: startTimeIso,
            status: APPOINTMENT_STATUSES.CONFIRMADA,
        })
        .select('id')
        .single();
    if (error || !data) throw new Error(`No se pudo crear la cita de prueba: ${error?.message}`);
    return data.id;
}

describe('src/jobs/notify-pending-outcomes.ts — B.3', () => {
    const createdOrgIds: string[] = [];

    afterEach(async () => {
        vi.mocked(sendPendingOutcomeReminderEmail).mockReset();
        if (createdOrgIds.length > 0) {
            const ids = createdOrgIds.splice(0);
            await supabaseAdmin.from('appointments').delete().in('organization_id', ids);
            await supabaseAdmin.from('organizations').delete().in('id', ids);
        }
    });

    beforeEach(() => {
        vi.mocked(sendPendingOutcomeReminderEmail).mockResolvedValue({ data: { id: 'unused' } } as any);
    });

    it('una sola cita reciente (1 día) sin desenlace → NO notifica (umbral no alcanzado)', async () => {
        const orgId = await createOrg();
        createdOrgIds.push(orgId);
        await createPastAppointment(orgId, daysAgo(1));

        await notifyPendingOutcomesHandler(buildFakeFastify());

        expect(callsForOrg(orgId)).toHaveLength(0);
    });

    it('contraparte: 3 citas recientes acumuladas sin desenlace → SÍ notifica', async () => {
        const orgId = await createOrg();
        createdOrgIds.push(orgId);
        await createPastAppointment(orgId, daysAgo(1));
        await createPastAppointment(orgId, daysAgo(1));
        await createPastAppointment(orgId, daysAgo(1));

        await notifyPendingOutcomesHandler(buildFakeFastify());

        const calls = callsForOrg(orgId);
        expect(calls).toHaveLength(1);
        expect(calls[0][0].data.appointments).toHaveLength(3);
    });

    it('contraparte: una sola cita con más de 3 días de retraso → SÍ notifica aunque sea la única', async () => {
        const orgId = await createOrg();
        createdOrgIds.push(orgId);
        await createPastAppointment(orgId, daysAgo(5));

        await notifyPendingOutcomesHandler(buildFakeFastify());

        const calls = callsForOrg(orgId);
        expect(calls).toHaveLength(1);
        expect(calls[0][0].data.appointments[0].daysOverdue).toBeGreaterThan(3);
    });

    it('una organización sin email de notificación se omite, aunque supere el umbral', async () => {
        const orgId = await createOrg(false);
        createdOrgIds.push(orgId);
        await createPastAppointment(orgId, daysAgo(5));
        await createPastAppointment(orgId, daysAgo(5));
        await createPastAppointment(orgId, daysAgo(5));

        await notifyPendingOutcomesHandler(buildFakeFastify());

        expect(callsForOrg(orgId)).toHaveLength(0);
    });

    it('citas futuras o ya con desenlace (completada/no_asistio/cancelada) no cuentan para el umbral', async () => {
        const orgId = await createOrg();
        createdOrgIds.push(orgId);
        // Futura: no aparece en v_citas_sin_desenlace (start_time < now() es la condición).
        await createPastAppointment(orgId, new Date(Date.now() + 86400000).toISOString());
        // Con desenlace ya marcado: tampoco aparece (status fuera de programada/confirmada).
        await supabaseAdmin
            .from('appointments')
            .insert({
                organization_id: orgId,
                customer_name: 'Ya Resuelta',
                start_time: daysAgo(5),
                end_time: daysAgo(5),
                status: APPOINTMENT_STATUSES.COMPLETADA,
            });

        await notifyPendingOutcomesHandler(buildFakeFastify());

        expect(callsForOrg(orgId)).toHaveLength(0);
    });
});
