import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, clearSecretCache } from '../src/services/secret-service.js';
import { clearEntitlementsCache } from '../src/services/entitlements.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { waitlistToolRoute } from '../src/routes/tools/waitlist.js';
import { WAITLIST_PRIORITIES, WAITLIST_STATUSES } from '../src/types/waitlist.js';

const TEST_TOOL_SECRET = 'waitlist-route-test-secret';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    app.decorate('supabaseAdmin', supabaseAdmin);
    await app.register(waitlistToolRoute);
    await app.ready();
    return app;
}

describe('POST /tools/:webhookToken/waitlist', () => {
    const TEST_WEBHOOK_TOKEN = `waitlist-test-token-${Date.now()}`;
    const createdWaitlistIds: string[] = [];
    const createdContactIds: string[] = [];
    let orgId: string;

    beforeAll(async () => {
        const { data: org, error: orgErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org (tools-waitlist.test.ts)',
                email: `org-tools-waitlist-test-${Date.now()}@example.invalid`,
                webhook_token: TEST_WEBHOOK_TOKEN,
                status: 'active',
                plan_key: 'elite', // Plan con feature waitlist
            })
            .select('id')
            .single();
        if (orgErr || !org) throw new Error(`No se pudo crear la organización de prueba: ${orgErr?.message}`);
        orgId = org.id;

        const saved = await setSecret(orgId, SECRET_KEYS.TOOL_WEBHOOK_SECRET, TEST_TOOL_SECRET);
        if (!saved) throw new Error('No se pudo guardar tool_webhook_secret de prueba');
        clearSecretCache(orgId);
    });

    afterAll(async () => {
        if (createdWaitlistIds.length > 0) {
            await supabaseAdmin.from('appointment_waitlist').delete().in('id', createdWaitlistIds);
        }
        if (createdContactIds.length > 0) {
            await supabaseAdmin.from('contacts').delete().in('id', createdContactIds);
        }
        await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', orgId);
        clearSecretCache(orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
    });

    beforeEach(() => {
        clearSecretCache(orgId);
        clearEntitlementsCache(orgId);
    });

    it('rechaza con 401 si falta o es inválido el x-tool-secret', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/waitlist`,
                payload: {
                    conversationId: 'conv-test-1',
                    customerName: 'Juan Pérez',
                    customerPhone: '5512345678',
                    preferredDateStart: '2026-09-01',
                    preferredDateEnd: '2026-09-01',
                },
            });
            expect(response.statusCode).toBe(401);
            expect(response.json().error).toBe('Unauthorized');
        } finally {
            await app.close();
        }
    });

    it('rechaza con 403 Forbidden si la organización está suspendida', async () => {
        await supabaseAdmin.from('organizations').update({ status: 'suspended', suspended_reason: 'Mantenimiento' }).eq('id', orgId);
        clearSecretCache(orgId);

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/waitlist`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: {
                    conversationId: 'conv-test-2',
                    customerName: 'Juan Pérez',
                    customerPhone: '5512345678',
                    preferredDateStart: '2026-09-01',
                    preferredDateEnd: '2026-09-01',
                },
            });
            expect(response.statusCode).toBe(403);
            expect(response.json().error).toBe('Forbidden');
        } finally {
            await supabaseAdmin.from('organizations').update({ status: 'active', suspended_reason: null, suspended_at: null }).eq('id', orgId);
            clearSecretCache(orgId);
            await app.close();
        }
    });

    it('rechaza con 400 si faltan campos obligatorios en el body', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/waitlist`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: {
                    customerName: 'Juan Pérez', // Falta conversationId, customerPhone, fechas
                },
            });
            expect(response.statusCode).toBe(400);
            expect(response.json().error).toBe('BadRequest');
        } finally {
            await app.close();
        }
    });

    it('responde amablemente sin error si la organización no tiene la feature waitlist', async () => {
        // Cambiamos temporalmente a starter
        await supabaseAdmin.from('organizations').update({ plan_key: 'starter' }).eq('id', orgId);
        clearEntitlementsCache(orgId);

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/waitlist`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: {
                    conversationId: 'conv-test-starter',
                    customerName: 'Juan Pérez',
                    customerPhone: '5512345678',
                    preferredDateStart: '2026-09-01',
                    preferredDateEnd: '2026-09-01',
                },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.waitlisted).toBe(false);
            expect(body.message).toContain('no contamos con lista de espera');
        } finally {
            await supabaseAdmin.from('organizations').update({ plan_key: 'elite' }).eq('id', orgId);
            clearEntitlementsCache(orgId);
            await app.close();
        }
    });

    it('registra exitosamente al prospecto en la lista de espera con prioridad normal si es nuevo', async () => {
        const app = await buildTestApp();
        const convId = `conv-new-${Date.now()}`;
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/waitlist`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: {
                    conversationId: convId,
                    customerName: 'Carlos Prospecto',
                    customerPhone: '55 1234 5678',
                    customerEmail: 'carlos@example.invalid',
                    partySize: 4,
                    preferredDateStart: '2026-09-05',
                    preferredDateEnd: '2026-09-05',
                    preferredTimeStart: '19:00:00',
                    preferredTimeEnd: '21:00:00',
                    notes: 'Mesa exterior si es posible',
                },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.waitlisted).toBe(true);
            expect(body.waitlistId).toBeDefined();
            createdWaitlistIds.push(body.waitlistId);

            const { data: row } = await supabaseAdmin
                .from('appointment_waitlist')
                .select('*')
                .eq('id', body.waitlistId)
                .single();

            expect(row).not.toBeNull();
            expect(row.customer_phone).toBe('+525512345678');
            expect(row.party_size).toBe(4);
            expect(row.status).toBe(WAITLIST_STATUSES.PENDIENTE);
            expect(row.priority).toBe(WAITLIST_PRIORITIES.NORMAL);
        } finally {
            await app.close();
        }
    });

    it('idempotencia: reintentar con el mismo conversationId no duplica la fila', async () => {
        const app = await buildTestApp();
        const convId = `conv-idemp-${Date.now()}`;
        try {
            const payload = {
                conversationId: convId,
                customerName: 'Diana Reintento',
                customerPhone: '55 9988 7766',
                preferredDateStart: '2026-09-06',
                preferredDateEnd: '2026-09-06',
            };

            const firstRes = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/waitlist`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload,
            });
            expect(firstRes.statusCode).toBe(200);
            const firstBody = firstRes.json();
            expect(firstBody.waitlisted).toBe(true);
            createdWaitlistIds.push(firstBody.waitlistId);

            const secondRes = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/waitlist`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload,
            });
            expect(secondRes.statusCode).toBe(200);
            const secondBody = secondRes.json();
            expect(secondBody.waitlisted).toBe(true);
            expect(secondBody.waitlistId).toBe(firstBody.waitlistId);

            const { data: rows } = await supabaseAdmin
                .from('appointment_waitlist')
                .select('id')
                .eq('organization_id', orgId)
                .eq('conversation_id', convId);

            expect(rows?.length).toBe(1);
        } finally {
            await app.close();
        }
    });

    it('asigna prioridad alta si el contacto ya existe previamente en el CRM', async () => {
        const phoneE164 = '+525544332211';
        const { data: contact, error: contactErr } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: orgId,
                full_name: 'Cliente Existente VIP',
                phone_e164: phoneE164,
            })
            .select('id')
            .single();
        if (contactErr || !contact) throw new Error(`No se pudo crear el contacto: ${contactErr?.message}`);
        createdContactIds.push(contact.id);

        const app = await buildTestApp();
        const convId = `conv-vip-${Date.now()}`;
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/waitlist`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: {
                    conversationId: convId,
                    customerName: 'Cliente Existente VIP',
                    customerPhone: '55 4433 2211',
                    preferredDateStart: '2026-09-07',
                    preferredDateEnd: '2026-09-07',
                },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.waitlisted).toBe(true);
            createdWaitlistIds.push(body.waitlistId);

            const { data: row } = await supabaseAdmin
                .from('appointment_waitlist')
                .select('*')
                .eq('id', body.waitlistId)
                .single();

            expect(row.priority).toBe(WAITLIST_PRIORITIES.ALTA);
            expect(row.contact_id).toBe(contact?.id);
        } finally {
            await app.close();
        }
    });
});
