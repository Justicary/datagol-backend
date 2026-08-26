import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import appointmentsAdminRoutes from '../src/routes/appointments-admin.js';
import { clearEntitlementsCache } from '../src/services/entitlements.js';
import { APPOINTMENT_STATUSES } from '../src/types/appointment-status.js';
import { SEND_BULK_CONFIRMATION_REQUEST_QUEUE } from '../src/jobs/send-bulk-confirmation-request.js';

const env = validateEnv();

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    const pgBossSendSpy = vi.fn().mockResolvedValue('job-id');
    app.decorate('pgBoss', { send: pgBossSendSpy } as any);
    await app.register(appointmentsAdminRoutes);
    await app.ready();
    return { app, pgBossSendSpy };
}

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-bulk-confirm-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createErr || !created.user) throw new Error(`No se pudo crear el usuario de prueba: ${createErr?.message}`);

    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) throw new Error(`No se pudo iniciar sesión de prueba: ${signInErr?.message}`);

    return { userId: created.user.id, jwt: session.session.access_token };
}

function randomMxPhone(): string {
    return `+5255${Math.floor(Math.random() * 90000000 + 10000000)}`;
}

describe('POST /api/organizations/:id/appointments/bulk-confirm', () => {
    let owner: TestUser;
    let member: TestUser;
    let orgId: string;
    const createdAppointmentIds: string[] = [];
    // Fecha objetivo fija (no "mañana"/"hoy") para que la prueba no dependa
    // de la hora local en que corre CI.
    const targetDate = '2027-03-15';
    const [TARGET_YEAR, TARGET_MONTH, TARGET_DAY] = targetDate.split('-').map(Number);
    // America/Mexico_City es UTC-6 todo el año desde que México abolió el
    // horario de verano en 2022 — sin esa constante, convertir hora local a
    // UTC a mano en este archivo de prueba requeriría reimplementar
    // zonedDateTimeToUtc.
    const MX_UTC_OFFSET_HOURS = 6;

    function localMxToIso(day: number, hourLocal: number, minuteLocal: number): string {
        const utcMs = Date.UTC(TARGET_YEAR, TARGET_MONTH - 1, day, hourLocal, minuteLocal, 0, 0) + MX_UTC_OFFSET_HOURS * 60 * 60 * 1000;
        return new Date(utcMs).toISOString();
    }

    beforeAll(async () => {
        owner = await createTestUserWithJwt();
        member = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Bulk Confirm Test Org',
            p_email: `bulk-confirm-test-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`Setup falló creando organización: ${error?.message}`);
        orgId = org.id;

        await supabaseAdmin.from('organizations').update({ timezone: 'America/Mexico_City' }).eq('id', orgId);

        const { error: memberErr } = await supabaseAdmin
            .from('organization_members')
            .insert({ organization_id: orgId, user_id: member.userId, role: 'member' });
        if (memberErr) throw new Error(`Setup falló agregando member: ${memberErr.message}`);

        const { error: featureErr } = await supabaseAdmin
            .from('organization_features')
            .insert({ organization_id: orgId, feature_key: 'waitlist', enabled: true, reason: 'appointments-admin-bulk-confirm.test.ts' });
        if (featureErr) throw new Error(`Setup falló habilitando feature waitlist: ${featureErr.message}`);
        clearEntitlementsCache();
    });

    afterAll(async () => {
        if (createdAppointmentIds.length) {
            await supabaseAdmin.from('appointments').delete().in('id', createdAppointmentIds);
        }
        await supabaseAdmin.from('organization_features').delete().eq('organization_id', orgId).eq('feature_key', 'waitlist');
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await supabaseAdmin.auth.admin.deleteUser(owner.userId);
        await supabaseAdmin.auth.admin.deleteUser(member.userId);
        clearEntitlementsCache();
    });

    async function createAppointment(hourLocal: number, minuteLocal: number, overrides: Record<string, unknown> = {}) {
        const startTime = localMxToIso(TARGET_DAY, hourLocal, minuteLocal);
        const endTime = new Date(new Date(startTime).getTime() + 30 * 60 * 1000).toISOString();
        const { data, error } = await supabaseAdmin
            .from('appointments')
            .insert({
                organization_id: orgId,
                customer_name: 'Cliente Bulk Confirm',
                customer_phone: randomMxPhone(),
                start_time: startTime,
                end_time: endTime,
                status: APPOINTMENT_STATUSES.CONFIRMADA,
                ...overrides,
            })
            .select('id')
            .single();
        if (error || !data) throw new Error(`No se pudo crear cita de prueba: ${error?.message}`);
        createdAppointmentIds.push(data.id);
        return data.id as string;
    }

    it('sin permiso manage_waitlist responde 403', async () => {
        const { app } = await buildTestApp();
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/appointments/bulk-confirm`,
            headers: { authorization: `Bearer ${member.jwt}` },
            payload: { date: targetDate },
        });
        expect(res.statusCode).toBe(403);
        await app.close();
    });

    it('sin la feature waitlist habilitada responde 403 con requiredFeature', async () => {
        await supabaseAdmin.from('organization_features').update({ enabled: false }).eq('organization_id', orgId).eq('feature_key', 'waitlist');
        clearEntitlementsCache();

        const { app } = await buildTestApp();
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/appointments/bulk-confirm`,
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: { date: targetDate },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().requiredFeature).toBe('waitlist');
        await app.close();

        await supabaseAdmin.from('organization_features').update({ enabled: true }).eq('organization_id', orgId).eq('feature_key', 'waitlist');
        clearEntitlementsCache();
    });

    it('encola solo las citas elegibles del día indicado, en la zona horaria de la organización', async () => {
        const eligibleId = await createAppointment(9, 0);
        // 23:30 local del mismo día — sigue siendo targetDate en México aunque
        // ya sea targetDate+1 en UTC; prueba real de que el filtro usa la
        // zona horaria de la organización, no medianoche UTC.
        const eligibleLateId = await createAppointment(23, 30);
        await createAppointment(10, 0, { status: APPOINTMENT_STATUSES.CANCELADA });
        await createAppointment(10, 0, { customer_phone: null });
        await createAppointment(10, 0, { confirmation_requested_at: new Date().toISOString() });
        // Fuera del día objetivo: 00:30 local del día siguiente.
        const { data: outOfRange, error: outOfRangeErr } = await supabaseAdmin
            .from('appointments')
            .insert({
                organization_id: orgId,
                customer_name: 'Cliente Fuera de Rango',
                customer_phone: randomMxPhone(),
                start_time: localMxToIso(TARGET_DAY + 1, 0, 30),
                end_time: localMxToIso(TARGET_DAY + 1, 1, 0),
                status: APPOINTMENT_STATUSES.CONFIRMADA,
            })
            .select('id')
            .single();
        if (outOfRangeErr || !outOfRange) throw new Error(`No se pudo crear cita fuera de rango: ${outOfRangeErr?.message}`);
        createdAppointmentIds.push(outOfRange.id);

        const { app, pgBossSendSpy } = await buildTestApp();
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/appointments/bulk-confirm`,
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: { date: targetDate },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.success).toBe(true);
        expect(body.queued).toBe(2);

        const queuedIds = pgBossSendSpy.mock.calls.map((call) => call[1].appointmentId);
        expect(queuedIds.sort()).toEqual([eligibleId, eligibleLateId].sort());
        for (const call of pgBossSendSpy.mock.calls) {
            expect(call[0]).toBe(SEND_BULK_CONFIRMATION_REQUEST_QUEUE);
        }

        await app.close();
    });

    it('rechaza un formato de fecha inválido con 400', async () => {
        const { app } = await buildTestApp();
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/appointments/bulk-confirm`,
            headers: { authorization: `Bearer ${owner.jwt}` },
            payload: { date: '15-03-2027' },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
    });
});
