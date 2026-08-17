import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationEmailRoutes, { clearTestEmailRateLimits } from '../src/routes/organization-email.js';
import * as emailService from '../src/services/email.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(organizationEmailRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
    email: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-email-admin-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
    });
    if (createErr || !created.user) {
        throw new Error(`No se pudo crear el usuario de prueba: ${createErr?.message}`);
    }

    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) {
        throw new Error(`No se pudo iniciar sesión de prueba: ${signInErr?.message}`);
    }

    return { userId: created.user.id, jwt: session.session.access_token, email };
}

async function deleteTestUser(userId: string): Promise<void> {
    await supabaseAdmin.auth.admin.deleteUser(userId);
}

async function deleteTestOrganization(organizationId: string): Promise<void> {
    await supabaseAdmin.from('organization_members').delete().eq('organization_id', organizationId);
    await supabaseAdmin.from('organizations').delete().eq('id', organizationId);
}

describe('routes/organization-email.ts (Fases D & E)', () => {
    let owner: TestUser;
    let member: TestUser;
    let outsider: TestUser;
    let organizationId: string;

    beforeAll(async () => {
        owner = await createTestUserWithJwt();
        member = await createTestUserWithJwt();
        outsider = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Organización de Prueba Email',
            p_email: `email-org-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`No se pudo crear la organización de prueba: ${error?.message}`);
        organizationId = org.id;

        // Agregar usuario con rol 'member' a la organización (no admin)
        await supabaseAdmin.from('organization_members').insert({
            organization_id: organizationId,
            user_id: member.userId,
            role: 'member',
        });

        // Configurar tema y settings de email en integration_settings
        await supabaseAdmin
            .from('organizations')
            .update({
                integration_settings: {
                    theme: { accentColor: '#10b981', accentSecondary: '#064e3b' },
                    email: {
                        template: 'corporativo',
                        logoUrl: 'https://cdn.ejemplo.com/logo.png',
                        footerText: 'Pie de prueba de la organización',
                        replyTo: 'contacto@ejemplo.com',
                    },
                },
            })
            .eq('id', organizationId);
    });

    afterAll(async () => {
        await deleteTestOrganization(organizationId);
        await deleteTestUser(owner.userId);
        await deleteTestUser(member.userId);
        await deleteTestUser(outsider.userId);
    });

    beforeEach(() => {
        clearTestEmailRateLimits();
    });

    describe('GET /api/organizations/:id/email/preview', () => {
        it('sin JWT → 401 Unauthorized', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${organizationId}/email/preview`,
                });
                expect(response.statusCode).toBe(401);
            } finally {
                await app.close();
            }
        });

        it('con usuario externo a la organización → 403 Forbidden', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${organizationId}/email/preview`,
                    headers: { authorization: `Bearer ${outsider.jwt}` },
                });
                expect(response.statusCode).toBe(403);
            } finally {
                await app.close();
            }
        });

        it('con rol member (no admin/owner) → 403 Forbidden', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${organizationId}/email/preview`,
                    headers: { authorization: `Bearer ${member.jwt}` },
                });
                expect(response.statusCode).toBe(403);
                expect(JSON.parse(response.body).error).toContain('rol admin u owner');
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: owner obtiene previsualización con tema real y datos ficticios (sin PII)', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${organizationId}/email/preview`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });

                expect(response.statusCode).toBe(200);
                const body = JSON.parse(response.body);
                expect(body.success).toBe(true);
                expect(body.data.template).toBe('corporativo');
                expect(body.data.type).toBe('call_summary');
                expect(body.data.html).toContain('Reporte de Llamada');
                expect(body.data.html).toContain('Pie de prueba de la organización');
                // Datos ficticios evidentes, sin PII real
                expect(body.data.html).toContain('+52 55 1234 5678');
                expect(body.data.text).toContain('=== REPORTE DE LLAMADA ===');
            } finally {
                await app.close();
            }
        });

        it('permite sobrescribir template y type mediante query params', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${organizationId}/email/preview?template=calido&type=hot_lead`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });

                expect(response.statusCode).toBe(200);
                const body = JSON.parse(response.body);
                expect(body.data.template).toBe('calido');
                expect(body.data.type).toBe('hot_lead');
                expect(body.data.html).toContain('Prospecto Caliente');
                expect(body.data.html).toContain('Juan Pérez');
            } finally {
                await app.close();
            }
        });

        it('devuelve HTML directo si el cliente envía header Accept: text/html', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${organizationId}/email/preview`,
                    headers: {
                        authorization: `Bearer ${owner.jwt}`,
                        accept: 'text/html',
                    },
                });

                expect(response.statusCode).toBe(200);
                expect(response.headers['content-type']).toContain('text/html');
                expect(response.body).toContain('<!DOCTYPE html>');
            } finally {
                await app.close();
            }
        });

        it('ruta sin prefijo /api (/organizations/:id/email/preview) funciona como alias idéntico', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'GET',
                    url: `/organizations/${organizationId}/email/preview`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });

                expect(response.statusCode).toBe(200);
                expect(JSON.parse(response.body).success).toBe(true);
            } finally {
                await app.close();
            }
        });
    });

    describe('POST /api/organizations/:id/email/test', () => {
        it('sin JWT → 401 Unauthorized', async () => {
            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${organizationId}/email/test`,
                    payload: {},
                });
                expect(response.statusCode).toBe(401);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: envía correo de prueba a la dirección del admin autenticado', async () => {
            const mockSend = vi.fn().mockResolvedValue({ data: { id: 'test-email-msg-id-123' } });
            const spyResend = vi.spyOn(emailService, 'getResendClient').mockReturnValue({
                emails: { send: mockSend },
            } as any);

            const app = await buildTestApp();
            try {
                const response = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${organizationId}/email/test`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: {
                        template: 'profesional',
                        type: 'appointment_confirmation',
                    },
                });

                expect(response.statusCode).toBe(200);
                const body = JSON.parse(response.body);
                expect(body.success).toBe(true);
                expect(body.data.recipient).toBe(owner.email);
                expect(body.data.emailId).toBe('test-email-msg-id-123');

                expect(mockSend).toHaveBeenCalledTimes(1);
                const callArgs = mockSend.mock.calls[0][0];
                expect(callArgs.to).toBe(owner.email);
                expect(callArgs.subject).toContain('[PRUEBA]');
                expect(callArgs.html).toContain('Cita Confirmada');
                expect(callArgs.text).toContain('=== 📅 CITA CONFIRMADA ===');
            } finally {
                spyResend.mockRestore();
                await app.close();
            }
        });

        it('limita la tasa de envíos a máximo 5 cada 15 minutos (429 Too Many Requests)', async () => {
            const mockSend = vi.fn().mockResolvedValue({ data: { id: 'test-email-msg-id-123' } });
            const spyResend = vi.spyOn(emailService, 'getResendClient').mockReturnValue({
                emails: { send: mockSend },
            } as any);

            const app = await buildTestApp();
            try {
                // 5 envíos consecutivos permitidos
                for (let i = 0; i < 5; i++) {
                    const res = await app.inject({
                        method: 'POST',
                        url: `/api/organizations/${organizationId}/email/test`,
                        headers: { authorization: `Bearer ${owner.jwt}` },
                        payload: {},
                    });
                    expect(res.statusCode).toBe(200);
                }

                // El 6to debe ser rechazado con 429
                const rateLimitedRes = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${organizationId}/email/test`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: {},
                });

                expect(rateLimitedRes.statusCode).toBe(429);
                expect(JSON.parse(rateLimitedRes.body).error).toContain('Límite de envíos de prueba excedido');
            } finally {
                spyResend.mockRestore();
                await app.close();
            }
        });
    });
});
