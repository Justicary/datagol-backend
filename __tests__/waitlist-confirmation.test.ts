import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import crypto from 'crypto';
import supabasePlugin from '../src/plugins/supabase.js';
import { waitlistConfirmationRoutes } from '../src/routes/public/waitlist-confirmation.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { hashToken } from '../src/lib/token-hash.js';
import { WAITLIST_STATUSES } from '../src/types/waitlist.js';
import { APPOINTMENT_STATUSES } from '../src/types/appointment-status.js';
import { EVALUATE_WAITLIST_FOR_SLOT_QUEUE } from '../src/jobs/evaluate-waitlist-for-slot.js';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    const pgBossSendSpy = vi.fn().mockResolvedValue('job-id');
    app.decorate('pgBoss', { send: pgBossSendSpy } as any);
    await app.register(waitlistConfirmationRoutes);
    await app.ready();
    return { app, pgBossSendSpy };
}

describe('routes/public/waitlist-confirmation', () => {
    let orgId: string;
    const createdWaitlistIds: string[] = [];
    const createdAppointmentIds: string[] = [];

    beforeAll(async () => {
        const { data: org, error } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org (waitlist-confirmation.test.ts)',
                email: `org-waitlist-confirmation-test-${Date.now()}@example.invalid`,
                status: 'active',
                // cal_event_type_id se omite a propósito: sin él, la ruta
                // nunca intenta llamar a la API real de Cal.com.
            })
            .select('id')
            .single();
        if (error || !org) throw new Error(`No se pudo crear organización de prueba: ${error?.message}`);
        orgId = org.id;
    });

    afterAll(async () => {
        if (createdAppointmentIds.length) {
            await supabaseAdmin.from('appointments').delete().in('id', createdAppointmentIds);
        }
        if (createdWaitlistIds.length) {
            await supabaseAdmin.from('appointment_waitlist').delete().in('id', createdWaitlistIds);
        }
        if (orgId) {
            await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        }
    });

    let offerCounter = 0;

    // Teléfono/correo únicos por llamada: varias pruebas comparten `orgId`
    // (no se recrea por test), así que reusar el mismo contacto rompería el
    // aislamiento de los conteos de `appointments` entre pruebas.
    async function createOffer(overrides: Record<string, unknown> = {}) {
        offerCounter += 1;
        const suffix = String(offerCounter).padStart(4, '0');
        const customerPhone = `+52559990${suffix}`;
        const customerEmail = `cliente-waitlist-${suffix}-${Date.now()}@example.invalid`;

        const rawToken = crypto.randomBytes(32).toString('hex');
        const slotStart = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
        const slotEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString();
        const { data, error } = await supabaseAdmin
            .from('appointment_waitlist')
            .insert({
                organization_id: orgId,
                customer_name: 'Cliente Waitlist',
                customer_phone: customerPhone,
                customer_email: customerEmail,
                preferred_date_start: slotStart.slice(0, 10),
                preferred_date_end: slotStart.slice(0, 10),
                status: WAITLIST_STATUSES.OFERTADA,
                offer_token_hash: hashToken(rawToken),
                offer_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
                offered_slot_start: slotStart,
                offered_slot_end: slotEnd,
                ...overrides,
            })
            .select('id')
            .single();
        if (error || !data) throw new Error(`No se pudo crear oferta de prueba: ${error?.message}`);
        createdWaitlistIds.push(data.id);
        return { rawToken, waitlistId: data.id as string, slotStart, slotEnd, customerPhone };
    }

    it('GET con token inexistente devuelve la página neutra, no un error', async () => {
        const { app } = await buildTestApp();
        const res = await app.inject({ method: 'GET', url: `/api/waitlist/${'a'.repeat(64)}` });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('ya no está disponible');
        await app.close();
    });

    it('GET con formato de token inválido devuelve la página neutra', async () => {
        const { app } = await buildTestApp();
        const res = await app.inject({ method: 'GET', url: '/api/waitlist/token-con-formato-invalido' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('ya no está disponible');
        await app.close();
    });

    it('GET con oferta vigente renderiza la página con Confirmar/Rechazar', async () => {
        const { rawToken } = await createOffer();
        const { app } = await buildTestApp();
        const res = await app.inject({ method: 'GET', url: `/api/waitlist/${rawToken}` });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('Confirmar');
        expect(res.body).toContain('Rechazar');
        expect(res.headers['cache-control']).toBe('no-store');
        await app.close();
    });

    it('POST confirmar transiciona a confirmada y crea la cita', async () => {
        const { rawToken, waitlistId, slotStart } = await createOffer();
        const { app } = await buildTestApp();

        const res = await app.inject({ method: 'POST', url: `/api/waitlist/${rawToken}/confirmar` });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('¡Listo!');

        const { data: row } = await supabaseAdmin
            .from('appointment_waitlist')
            .select('status, offered_appointment_id')
            .eq('id', waitlistId)
            .single();
        expect(row?.status).toBe(WAITLIST_STATUSES.CONFIRMADA);
        expect(row?.offered_appointment_id).toBeTruthy();
        if (row?.offered_appointment_id) createdAppointmentIds.push(row.offered_appointment_id);

        const { data: appt } = await supabaseAdmin
            .from('appointments')
            .select('status, start_time, organization_id, cal_booking_id')
            .eq('id', row!.offered_appointment_id)
            .single();
        expect(appt?.status).toBe(APPOINTMENT_STATUSES.CONFIRMADA);
        expect(appt?.organization_id).toBe(orgId);
        expect(new Date(appt!.start_time).toISOString()).toBe(slotStart);
        // Sin cal_event_type_id en la organización, nunca se intentó Cal.com.
        expect(appt?.cal_booking_id).toBeNull();

        await app.close();
    });

    it('un segundo POST confirmar sobre el mismo token no crea una segunda cita', async () => {
        const { rawToken, waitlistId, customerPhone } = await createOffer();
        const { app } = await buildTestApp();

        const first = await app.inject({ method: 'POST', url: `/api/waitlist/${rawToken}/confirmar` });
        expect(first.statusCode).toBe(200);
        const { data: rowAfterFirst } = await supabaseAdmin
            .from('appointment_waitlist')
            .select('offered_appointment_id')
            .eq('id', waitlistId)
            .single();
        if (rowAfterFirst?.offered_appointment_id) createdAppointmentIds.push(rowAfterFirst.offered_appointment_id);

        const second = await app.inject({ method: 'POST', url: `/api/waitlist/${rawToken}/confirmar` });
        expect(second.statusCode).toBe(200);
        expect(second.body).toContain('ya no está disponible');

        const { count } = await supabaseAdmin
            .from('appointments')
            .select('id', { count: 'exact', head: true })
            .eq('customer_phone', customerPhone);
        // La segunda llamada no debe haber insertado otra fila para esta oferta.
        expect(count).toBe(1);

        await app.close();
    });

    it('POST confirmar después de vencido el TTL no confirma la oferta', async () => {
        const { rawToken, waitlistId } = await createOffer({ offer_expires_at: new Date(Date.now() - 60_000).toISOString() });
        const { app } = await buildTestApp();

        const res = await app.inject({ method: 'POST', url: `/api/waitlist/${rawToken}/confirmar` });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('ya no está disponible');

        const { data: row } = await supabaseAdmin.from('appointment_waitlist').select('status').eq('id', waitlistId).single();
        expect(row?.status).toBe(WAITLIST_STATUSES.OFERTADA);

        await app.close();
    });

    it('POST rechazar transiciona a rechazada y encola la promoción del siguiente candidato', async () => {
        const { rawToken, waitlistId, slotStart, slotEnd } = await createOffer();
        const { app, pgBossSendSpy } = await buildTestApp();

        const res = await app.inject({ method: 'POST', url: `/api/waitlist/${rawToken}/rechazar` });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('Entendido');

        const { data: row } = await supabaseAdmin.from('appointment_waitlist').select('status').eq('id', waitlistId).single();
        expect(row?.status).toBe(WAITLIST_STATUSES.RECHAZADA);

        // Postgres devuelve timestamptz con offset "+00:00", no "Z" — se
        // compara por instante, no por string exacto.
        expect(pgBossSendSpy).toHaveBeenCalledTimes(1);
        const [queueName, jobData] = pgBossSendSpy.mock.calls[0];
        expect(queueName).toBe(EVALUATE_WAITLIST_FOR_SLOT_QUEUE);
        expect(jobData.organizationId).toBe(orgId);
        expect(new Date(jobData.slotStartTime).getTime()).toBe(new Date(slotStart).getTime());
        expect(new Date(jobData.slotEndTime).getTime()).toBe(new Date(slotEnd).getTime());

        await app.close();
    });

    it('rechazar una oferta ya rechazada no vuelve a encolar la promoción (idempotencia)', async () => {
        const { rawToken } = await createOffer();
        const { app, pgBossSendSpy } = await buildTestApp();

        await app.inject({ method: 'POST', url: `/api/waitlist/${rawToken}/rechazar` });
        expect(pgBossSendSpy).toHaveBeenCalledTimes(1);

        const second = await app.inject({ method: 'POST', url: `/api/waitlist/${rawToken}/rechazar` });
        expect(second.statusCode).toBe(200);
        expect(second.body).toContain('ya no está disponible');
        expect(pgBossSendSpy).toHaveBeenCalledTimes(1);

        await app.close();
    });
});
