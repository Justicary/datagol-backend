import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import organizationReportsRoutes from '../src/routes/organization-reports.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(organizationReportsRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
}

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-reports-${crypto.randomUUID()}@example.invalid`;
    const password = `Pw-${crypto.randomBytes(16).toString('hex')}`;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createErr || !created.user) {
        throw new Error(`No se pudo crear el usuario de prueba: ${createErr?.message}`);
    }

    const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) {
        throw new Error(`No se pudo iniciar sesión de prueba: ${signInErr?.message}`);
    }

    return { userId: created.user.id, jwt: session.session.access_token };
}

describe('Rutas HTTP de reportes semanales (organization-reports.ts)', () => {
    let app: FastifyInstance;
    let owner: TestUser;
    let member: TestUser;
    let outsider: TestUser;
    let orgId: string;
    let reportId: string;

    beforeAll(async () => {
        app = await buildTestApp();
        [owner, member, outsider] = await Promise.all([createTestUserWithJwt(), createTestUserWithJwt(), createTestUserWithJwt()]);

        const { data: org, error: orgErr } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Org Reportes Test',
            p_email: `org-reports-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: '+525512345678',
            p_user_id: owner.userId,
        });
        if (orgErr || !org) throw new Error(`No se pudo crear la organización de prueba: ${orgErr?.message}`);
        orgId = org.id;

        const { error: memberErr } = await supabaseAdmin
            .from('organization_members')
            .insert({ organization_id: orgId, user_id: member.userId, role: 'member' });
        if (memberErr) throw new Error(`No se pudo agregar al miembro de prueba: ${memberErr.message}`);

        const { data: report, error: reportErr } = await supabaseAdmin
            .from('weekly_reports')
            .insert({
                organization_id: orgId,
                report_type: 'planning',
                week_start: '2026-02-02',
                status: 'generated',
                data: {},
                storage_path: `${orgId}/planning/2026-02-02.html`,
            })
            .select('id')
            .single();
        if (reportErr || !report) throw new Error(`No se pudo crear el reporte de prueba: ${reportErr?.message}`);
        reportId = report.id;

        // Sube un HTML real para que la ruta de descarga pueda generar una signed URL válida.
        await supabaseAdmin.storage.createBucket('organization-reports', { public: false }).catch(() => undefined);
        await supabaseAdmin.storage.from('organization-reports').upload(`${orgId}/planning/2026-02-02.html`, Buffer.from('<html></html>'), {
            contentType: 'text/html',
            upsert: true,
        });
    });

    afterAll(async () => {
        await app.close();
        await supabaseAdmin.storage.from('organization-reports').remove([`${orgId}/planning/2026-02-02.html`]);
        await supabaseAdmin.from('weekly_reports').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await Promise.all([owner, member, outsider].map((u) => supabaseAdmin.auth.admin.deleteUser(u.userId)));
    });

    describe('GET /api/organizations/:id/reports', () => {
        it('un miembro (no solo el owner) puede listar los reportes', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/reports`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.success).toBe(true);
            expect(body.data.some((r: { id: string }) => r.id === reportId)).toBe(true);
        });

        it('un no-miembro recibe 403', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/reports`,
                headers: { authorization: `Bearer ${outsider.jwt}` },
            });
            expect(res.statusCode).toBe(403);
        });
    });

    describe('GET /api/organizations/:id/reports/:reportId/download', () => {
        it('un miembro recibe un redirect 302 a una URL firmada', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/reports/${reportId}/download`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });
            expect(res.statusCode).toBe(302);
            expect(res.headers.location).toContain('organization-reports');
        });

        it('un no-miembro recibe 403, sin importar que el reporte exista', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/reports/${reportId}/download`,
                headers: { authorization: `Bearer ${outsider.jwt}` },
            });
            expect(res.statusCode).toBe(403);
        });

        it('404 para un reportId que no pertenece a la organización', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/reports/${crypto.randomUUID()}/download`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });
            expect(res.statusCode).toBe(404);
        });
    });

    describe('GET/PATCH /api/organizations/:id/reports-config', () => {
        it('GET devuelve la configuración con defaults cuando nunca se configuró', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/reports-config`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.planning).toMatchObject({ dayOfWeek: 1, hour: 6, channels: ['email'] });
        });

        it('un miembro sin rol admin/owner recibe 403 al intentar PATCH', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${orgId}/reports-config`,
                headers: { authorization: `Bearer ${member.jwt}`, 'content-type': 'application/json' },
                payload: { planning: { hour: 8 } },
            });
            expect(res.statusCode).toBe(403);
        });

        it('contraparte de éxito: el owner puede actualizar la configuración', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/organizations/${orgId}/reports-config`,
                headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': 'application/json' },
                payload: { planning: { hour: 8 }, whatsappTemplateName: 'reporte_semanal' },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.data.planning.hour).toBe(8);
            expect(body.data.whatsappTemplateName).toBe('reporte_semanal');
            // El resto de planning (dayOfWeek/channels) debe conservarse — merge, no reemplazo completo.
            expect(body.data.planning.dayOfWeek).toBe(1);
        });
    });

    describe('GET /api/organizations/:id/reports/preview', () => {
        it('devuelve 403 a un usuario ajeno a la organización', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/reports/preview?type=planning`,
                headers: { authorization: `Bearer ${outsider.jwt}` },
            });
            expect(res.statusCode).toBe(403);
        });

        it('devuelve la vista previa JSON de planificación para un miembro', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/reports/preview?type=planning`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.success).toBe(true);
            expect(body.data.reportType).toBe('planning');
            expect(typeof body.data.subject).toBe('string');
            expect(typeof body.data.html).toBe('string');
            expect(body.data.html).toContain('<!DOCTYPE html>');
        });

        it('devuelve la vista previa del reporte ejecutivo para el alias sin prefijo /api', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/organizations/${orgId}/reports/preview?type=executive`,
                headers: { authorization: `Bearer ${member.jwt}` },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.success).toBe(true);
            expect(body.data.reportType).toBe('executive');
            expect(typeof body.data.subject).toBe('string');
            expect(typeof body.data.html).toBe('string');
        });

        it('devuelve HTML directo cuando se envía el header Accept: text/html', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/organizations/${orgId}/reports/preview?type=planning`,
                headers: {
                    authorization: `Bearer ${member.jwt}`,
                    accept: 'text/html',
                },
            });
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/html');
            expect(res.body).toContain('<!DOCTYPE html>');
        });
    });
});
