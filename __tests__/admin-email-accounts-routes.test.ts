import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

let imapShouldFail = false;
let smtpShouldFail = false;
let smtpVerifyError: Error | null = null;
let lastSmtpTransportConfig: { port?: number; secure?: boolean; requireTLS?: boolean } | null = null;

vi.mock('imapflow', () => ({
    // `new ImapFlow(...)` exige que la implementación sea invocable con
    // `new` — una arrow function no lo es (lanza "is not a constructor").
    ImapFlow: vi.fn().mockImplementation(function ImapFlowMock() {
        return {
            connect: vi.fn().mockImplementation(async () => {
                if (imapShouldFail) throw new Error('Simulated IMAP connection failure');
            }),
            logout: vi.fn().mockResolvedValue(undefined),
        };
    }),
}));

vi.mock('nodemailer', () => ({
    default: {
        createTransport: vi.fn().mockImplementation((config: { port?: number; secure?: boolean; requireTLS?: boolean }) => {
            lastSmtpTransportConfig = config;
            return {
                verify: vi.fn().mockImplementation(async () => {
                    if (smtpVerifyError) throw smtpVerifyError;
                    if (smtpShouldFail) throw new Error('Simulated SMTP connection failure');
                    return true;
                }),
                close: vi.fn(),
            };
        }),
    },
}));

import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import adminEmailAccountsRoutes from '../src/routes/admin/email-accounts.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setFeatureOverride, clearEntitlementsCache } from '../src/services/entitlements.js';
import { FEATURE_KEYS } from '../src/types/feature-taxonomy.js';
import { deleteAccountCredentials } from '../src/services/email/email-account-vault.js';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(adminEmailAccountsRoutes);
    await app.ready();
    return app;
}

function validBody(overrides: Record<string, unknown> = {}) {
    return {
        emailAddress: `buzon-admin-${crypto.randomUUID()}@example.invalid`,
        imapHost: 'imap.example.invalid',
        imapPort: 993,
        imapSecure: true,
        imapUsername: 'usuario-imap',
        imapPassword: 'clave-imap',
        smtpHost: 'smtp.example.invalid',
        smtpPort: 465,
        smtpSecure: true,
        smtpUsername: 'usuario-smtp',
        smtpPassword: 'clave-smtp',
        ...overrides,
    };
}

describe('CRUD administrativo de buzones (/api/admin/email-accounts)', () => {
    let orgId: string;
    let orgWithoutFeatureId: string;
    const createdAccountIds: string[] = [];

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org Pruebas Admin Email Accounts', email: `test-admin-email-accounts-${crypto.randomUUID()}@example.invalid` })
            .select('id')
            .single();
        if (error || !data) throw new Error(`No se pudo crear la organización: ${error?.message}`);
        orgId = data.id as string;

        const overrideResult = await setFeatureOverride(orgId, FEATURE_KEYS.EMAIL_INTEGRATION, true, 'Habilitado para pruebas automatizadas');
        if (!overrideResult.success) throw new Error(`No se pudo habilitar email_integration: ${overrideResult.error}`);

        const { data: org2, error: err2 } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org Pruebas Sin Feature', email: `test-admin-email-accounts-no-feat-${crypto.randomUUID()}@example.invalid` })
            .select('id')
            .single();
        if (err2 || !org2) throw new Error(`No se pudo crear la segunda organización: ${err2?.message}`);
        orgWithoutFeatureId = org2.id as string;
    });

    afterAll(async () => {
        for (const accountId of createdAccountIds) {
            const { data: row } = await supabaseAdmin.from('email_accounts').select('vault_secret_id').eq('id', accountId).maybeSingle();
            if (row?.vault_secret_id) await deleteAccountCredentials(row.vault_secret_id as string);
        }
        await supabaseAdmin.from('email_accounts').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organization_features').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('feature_audit_log').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgWithoutFeatureId);
        // Invalidación acotada a las orgs de esta prueba — un clearEntitlementsCache()
        // global aquí invalidaría también el caché de otras organizaciones
        // (p.ej. REAL_ORG_ID) que otros archivos de prueba asumen tibio.
        clearEntitlementsCache(orgId);
        clearEntitlementsCache(orgWithoutFeatureId);
    });

    beforeEach(() => {
        imapShouldFail = false;
        smtpShouldFail = false;
        smtpVerifyError = null;
        lastSmtpTransportConfig = null;
    });

    describe('GET /api/admin/email-accounts/organization/:orgId', () => {
        it('rechaza con 401 sin autenticación de plataforma', async () => {
            const app = await buildTestApp();
            const response = await app.inject({ method: 'GET', url: `/api/admin/email-accounts/organization/${orgId}` });
            expect(response.statusCode).toBe(401);
            await app.close();
        });

        it('contraparte de éxito: devuelve accounts y maxMailboxes con autenticación válida', async () => {
            const app = await buildTestApp();
            const response = await app.inject({
                method: 'GET',
                url: `/api/admin/email-accounts/organization/${orgId}`,
                headers: { 'x-platform-admin': 'true' },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(Array.isArray(body.accounts)).toBe(true);
            expect(body).toHaveProperty('maxMailboxes');
            await app.close();
        });
    });

    describe('POST /api/admin/email-accounts/organization/:orgId', () => {
        it('rechaza con 403 si la feature email_integration no está habilitada', async () => {
            const app = await buildTestApp();
            const response = await app.inject({
                method: 'POST',
                url: `/api/admin/email-accounts/organization/${orgWithoutFeatureId}`,
                headers: { 'x-platform-admin': 'true' },
                payload: validBody(),
            });
            expect(response.statusCode).toBe(403);
            expect(response.json().code).toBe('FEATURE_DISABLED');
            await app.close();
        });

        it('rechaza con 400 si falta "emailAddress"', async () => {
            const app = await buildTestApp();
            const { emailAddress: _omitted, ...rest } = validBody();
            const response = await app.inject({
                method: 'POST',
                url: `/api/admin/email-accounts/organization/${orgId}`,
                headers: { 'x-platform-admin': 'true' },
                payload: rest,
            });
            expect(response.statusCode).toBe(400);
            await app.close();
        });

        it('rechaza con 400 si la conexión IMAP falla', async () => {
            imapShouldFail = true;
            const app = await buildTestApp();
            const response = await app.inject({
                method: 'POST',
                url: `/api/admin/email-accounts/organization/${orgId}`,
                headers: { 'x-platform-admin': 'true' },
                payload: validBody(),
            });
            expect(response.statusCode).toBe(400);
            await app.close();
        });

        it('contraparte de éxito: crea el buzón con datos válidos (201)', async () => {
            const app = await buildTestApp();
            const body = validBody();
            const response = await app.inject({
                method: 'POST',
                url: `/api/admin/email-accounts/organization/${orgId}`,
                headers: { 'x-platform-admin': 'true' },
                payload: body,
            });
            expect(response.statusCode).toBe(201);
            const resBody = response.json();
            expect(resBody.account.emailAddress).toBe(body.emailAddress);
            createdAccountIds.push(resBody.account.id);
            await app.close();
        });

        it('crea con éxito un buzón con smtpPort:587 y smtpSecure:true — la normalización defensiva evita el fallo de TLS', async () => {
            const app = await buildTestApp();
            const body = validBody({ smtpPort: 587, smtpSecure: true });
            const response = await app.inject({
                method: 'POST',
                url: `/api/admin/email-accounts/organization/${orgId}`,
                headers: { 'x-platform-admin': 'true' },
                payload: body,
            });
            expect(response.statusCode).toBe(201);
            expect(lastSmtpTransportConfig).toMatchObject({ port: 587, secure: false, requireTLS: true });
            createdAccountIds.push(response.json().account.id);
            await app.close();
        });

        it('crea con éxito un buzón con smtpPort:465 — se fuerza secure:true sin requireTLS', async () => {
            const app = await buildTestApp();
            const body = validBody({ smtpPort: 465, smtpSecure: false }); // el cliente manda secure:false pero el puerto manda
            const response = await app.inject({
                method: 'POST',
                url: `/api/admin/email-accounts/organization/${orgId}`,
                headers: { 'x-platform-admin': 'true' },
                payload: body,
            });
            expect(response.statusCode).toBe(201);
            expect(lastSmtpTransportConfig).toMatchObject({ port: 465, secure: true, requireTLS: undefined });
            createdAccountIds.push(response.json().account.id);
            await app.close();
        });

        it('traduce el error OpenSSL de desajuste TLS/puerto al mensaje accionable en la respuesta 400', async () => {
            smtpVerifyError = new Error('140736 SSL routines:tls_validate_record_header:wrong version number:../ssl/record.c:1000:');
            const app = await buildTestApp();
            const response = await app.inject({
                method: 'POST',
                url: `/api/admin/email-accounts/organization/${orgId}`,
                headers: { 'x-platform-admin': 'true' },
                payload: validBody(),
            });
            expect(response.statusCode).toBe(400);
            // email-account.service.ts envuelve el mensaje de smtp-client.ts
            // dentro de su propio "No se pudo validar la conexión SMTP..." —
            // se verifica que el texto accionable sobreviva anidado, no una
            // igualdad exacta.
            expect(response.json().message).toContain(
                'Error de protocolo SSL/TLS: El puerto configurado no coincide con el modo de cifrado (usa puerto 465 para SSL/TLS o puerto 587 para STARTTLS).'
            );
            await app.close();
        });
    });

    describe('DELETE /api/admin/email-accounts/organization/:orgId/:accountId', () => {
        it('rechaza con 401 sin autenticación de plataforma', async () => {
            const app = await buildTestApp();
            const response = await app.inject({ method: 'DELETE', url: `/api/admin/email-accounts/organization/${orgId}/${crypto.randomUUID()}` });
            expect(response.statusCode).toBe(401);
            await app.close();
        });

        it('devuelve 404 si el buzón no existe', async () => {
            const app = await buildTestApp();
            const response = await app.inject({
                method: 'DELETE',
                url: `/api/admin/email-accounts/organization/${orgId}/${crypto.randomUUID()}`,
                headers: { 'x-platform-admin': 'true' },
            });
            expect(response.statusCode).toBe(404);
            await app.close();
        });

        it('contraparte de éxito: desvincula un buzón existente (200)', async () => {
            const app = await buildTestApp();
            const createResponse = await app.inject({
                method: 'POST',
                url: `/api/admin/email-accounts/organization/${orgId}`,
                headers: { 'x-platform-admin': 'true' },
                payload: validBody(),
            });
            const accountId = createResponse.json().account.id as string;

            const deleteResponse = await app.inject({
                method: 'DELETE',
                url: `/api/admin/email-accounts/organization/${orgId}/${accountId}`,
                headers: { 'x-platform-admin': 'true' },
            });
            expect(deleteResponse.statusCode).toBe(200);

            const { data: row } = await supabaseAdmin.from('email_accounts').select('id').eq('id', accountId).maybeSingle();
            expect(row).toBeNull();
            await app.close();
        });

        it('aislamiento multi-tenant: no desvincula un buzón usando el orgId de otra organización', async () => {
            const app = await buildTestApp();
            const createResponse = await app.inject({
                method: 'POST',
                url: `/api/admin/email-accounts/organization/${orgId}`,
                headers: { 'x-platform-admin': 'true' },
                payload: validBody(),
            });
            const accountId = createResponse.json().account.id as string;
            createdAccountIds.push(accountId);

            const deleteResponse = await app.inject({
                method: 'DELETE',
                url: `/api/admin/email-accounts/organization/${orgWithoutFeatureId}/${accountId}`,
                headers: { 'x-platform-admin': 'true' },
            });
            expect(deleteResponse.statusCode).toBe(404);

            const { data: row } = await supabaseAdmin.from('email_accounts').select('id').eq('id', accountId).maybeSingle();
            expect(row).not.toBeNull();
            await app.close();
        });
    });
});
