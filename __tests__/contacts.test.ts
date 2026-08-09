import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import contactsRoutes from '../src/routes/contacts.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(contactsRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
}

// Mismo patrón que __tests__/organization-onboarding.test.ts: JWT real vía
// signInWithPassword, no simulado — es el único modo de ejercitar de verdad
// fastify.supabaseUser(jwt) y RLS/SECURITY DEFINER reales.
async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-contacts-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createErr || !created.user) throw new Error(`No se pudo crear el usuario de prueba: ${createErr?.message}`);

    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) throw new Error(`No se pudo iniciar sesión de prueba: ${signInErr?.message}`);

    return { userId: created.user.id, jwt: session.session.access_token };
}

async function deleteTestUser(userId: string): Promise<void> {
    await supabaseAdmin.auth.admin.deleteUser(userId);
}

async function deleteTestOrganization(organizationId: string): Promise<void> {
    await supabaseAdmin.from('organization_members').delete().eq('organization_id', organizationId);
    await supabaseAdmin.from('organizations').delete().eq('id', organizationId);
}

describe('POST /api/organizations/:id/contacts/:contactId/erase — borrado ARCO', () => {
    let owner: TestUser;
    let outsider: TestUser;
    let orgId: string;
    let contactId: string;
    let conversationId: string;
    let phone: string;

    beforeAll(async () => {
        owner = await createTestUserWithJwt();
        outsider = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'ARCO Erasure Test Org',
            p_email: `arco-erasure-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`Setup falló: ${error?.message}`);
        orgId = org.id;

        phone = `+52165${Math.floor(Math.random() * 9000000 + 1000000)}`;
        conversationId = `arco-test-conv-${Date.now()}`;

        const { data: contact, error: contactError } = await supabaseAdmin
            .from('contacts')
            .insert({ organization_id: orgId, phone_e164: phone, full_name: 'Titular De Prueba', email: 'titular@example.invalid' })
            .select('id')
            .single();
        if (contactError || !contact) throw new Error(`Setup falló creando contacto: ${contactError?.message}`);
        contactId = contact.id;

        const { data: callLog, error: callLogError } = await supabaseAdmin
            .from('call_logs')
            .insert({
                organization_id: orgId,
                provider_call_id: conversationId,
                contact_id: contactId,
                caller_phone: phone,
                customer_name: 'Titular De Prueba',
                transcript: 'Cliente: Hola, mi nombre es Titular De Prueba.\nAgente: Mucho gusto.',
                summary: 'El titular solicitó información y compartió sus datos de contacto.',
            })
            .select('id')
            .single();
        if (callLogError || !callLog) throw new Error(`Setup falló creando call_log: ${callLogError?.message}`);

        await supabaseAdmin.from('leads').insert({
            organization_id: orgId,
            contact_id: contactId,
            call_log_id: callLog.id,
            channel: 'voice',
            conversation_id: conversationId,
            full_name: 'Titular De Prueba',
            email: 'titular@example.invalid',
            contact_phone: phone,
        });

        await supabaseAdmin.from('appointments').insert({
            organization_id: orgId,
            contact_id: contactId,
            conversation_id: `${conversationId}-appt`,
            customer_name: 'Titular De Prueba',
            customer_phone: phone,
            start_time: new Date(Date.now() + 86400000).toISOString(),
            end_time: new Date(Date.now() + 90000000).toISOString(),
            status: 'confirmed',
        });

        await supabaseAdmin.from('webhook_events').insert({
            organization_id: orgId,
            provider: 'elevenlabs',
            event_id: `post_call_transcription:${conversationId}`,
            event_type: 'post_call_transcription',
            raw_payload: {
                data: {
                    conversation_id: conversationId,
                    analysis: {
                        data_collection_results: {
                            nombre_completo_prospecto: { value: 'Titular De Prueba' },
                            telefono_contacto_prospecto: { value: phone },
                        },
                    },
                },
            },
        });
    });

    afterAll(async () => {
        await supabaseAdmin.from('webhook_events').delete().eq('event_id', `post_call_transcription:${conversationId}`);
        await supabaseAdmin.from('appointments').delete().eq('conversation_id', `${conversationId}-appt`);
        await supabaseAdmin.from('leads').delete().eq('conversation_id', conversationId);
        await supabaseAdmin.from('call_logs').delete().eq('provider_call_id', conversationId);
        await supabaseAdmin.from('contacts').delete().eq('id', contactId);
        await deleteTestOrganization(orgId);
        await deleteTestUser(owner.userId);
        await deleteTestUser(outsider.userId);
    });

    it('sin JWT → 401', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({ method: 'POST', url: `/api/organizations/${orgId}/contacts/${contactId}/erase` });
            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('con JWT válido pero sin membresía en la organización → 403', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/contacts/${contactId}/erase`,
                headers: { authorization: `Bearer ${outsider.jwt}` },
            });
            expect(response.statusCode).toBe(403);
        } finally {
            await app.close();
        }
    });

    it('miembro de la organización, pero el contactId no existe → 404', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/contacts/00000000-0000-0000-0000-000000000000/erase`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(response.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it('parámetros de ruta inválidos (no UUID) → 400', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/contacts/no-es-un-uuid/erase`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: el dueño de la organización borra el contacto — anonimiza identidad, purga transcript/summary y redacta el webhook', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/api/organizations/${orgId}/contacts/${contactId}/erase`,
                headers: { authorization: `Bearer ${owner.jwt}` },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.success).toBe(true);
            expect(body.data.contactId).toBe(contactId);

            const { data: contact } = await supabaseAdmin
                .from('contacts')
                .select('full_name, email, phone_e164, opted_out')
                .eq('id', contactId)
                .single();
            expect(contact?.full_name).toBeNull();
            expect(contact?.email).toBeNull();
            expect(contact?.opted_out).toBe(true);
            // phone_e164 se conserva a propósito (clave de supresión de opted_out).
            expect(contact?.phone_e164).toBe(phone);

            const { data: lead } = await supabaseAdmin
                .from('leads')
                .select('full_name, email, contact_phone')
                .eq('conversation_id', conversationId)
                .single();
            expect(lead?.full_name).toBeNull();
            expect(lead?.email).toBeNull();
            expect(lead?.contact_phone).toBeNull();

            const { data: callLog } = await supabaseAdmin
                .from('call_logs')
                .select('customer_name, transcript, summary, duration_seconds')
                .eq('provider_call_id', conversationId)
                .single();
            expect(callLog?.customer_name).toBeNull();
            expect(callLog?.transcript).toBeNull();
            expect(callLog?.summary).toBeNull();

            const { data: appointment } = await supabaseAdmin
                .from('appointments')
                .select('customer_name, customer_phone')
                .eq('conversation_id', `${conversationId}-appt`)
                .single();
            expect(appointment?.customer_name).toBe('Cliente eliminado (ARCO)');
            expect(appointment?.customer_phone).toBe('+000000000000');

            const { data: webhookEvent } = await supabaseAdmin
                .from('webhook_events')
                .select('raw_payload')
                .eq('event_id', `post_call_transcription:${conversationId}`)
                .single();
            expect((webhookEvent?.raw_payload as any)?.purged).toBe(true);
            expect((webhookEvent?.raw_payload as any)?.purged_reason).toBe('arco_erasure');
            expect(JSON.stringify(webhookEvent?.raw_payload)).not.toContain('Titular De Prueba');
        } finally {
            await app.close();
        }
    });
});
