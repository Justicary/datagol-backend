import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import contactsRoutes from '../src/routes/contacts.js';
import { ORGANIZATION_ROLES } from '../src/types/organization-roles.js';
import { PERMISSION_KEYS } from '../src/types/permission-keys.js';

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

async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-erase-rbac-${crypto.randomUUID()}@example.invalid`;
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

function randomMxPhone(): string {
    return `+5255${Math.floor(Math.random() * 90000000 + 10000000)}`;
}

/**
 * RBAC B.5 (docs/tasks/RBAC-permisos.md): `erase_contact_data` — role_permissions
 * (migración 45) NO lo concede a 'admin', solo a 'owner'.
 */
describe('routes/contacts.ts — RBAC erase_contact_data', () => {
    let app: FastifyInstance;
    let owner: TestUser;
    let admin: TestUser;
    let orgId: string;
    let contactId: string;

    beforeAll(async () => {
        app = await buildTestApp();
        owner = await createTestUserWithJwt();
        admin = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'Erase RBAC Test Org',
            p_email: `erase-rbac-test-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`Setup falló creando organización: ${error?.message}`);
        orgId = org.id;

        const { error: memberErr } = await supabaseAdmin
            .from('organization_members')
            .insert({ organization_id: orgId, user_id: admin.userId, role: ORGANIZATION_ROLES.ADMIN });
        if (memberErr) throw new Error(`Setup falló agregando admin: ${memberErr.message}`);

        const { data: newContactId, error: contactErr } = await supabaseAdmin.rpc('resolve_contact', {
            p_org_id: orgId,
            p_phone: randomMxPhone(),
            p_email: null,
        });
        if (contactErr || !newContactId) throw new Error(`Setup falló creando contacto: ${contactErr?.message}`);
        contactId = newContactId;
    });

    afterAll(async () => {
        await app.close();
        await supabaseAdmin.from('contacts').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await deleteTestUser(owner.userId);
        await deleteTestUser(admin.userId);
    });

    it('un admin recibe 403 al intentar el borrado ARCO', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/contacts/${contactId}/erase`,
            headers: { authorization: `Bearer ${admin.jwt}` },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().requiredPermission).toBe(PERMISSION_KEYS.ERASE_CONTACT_DATA);
    });

    it('contraparte de éxito: el owner sí puede completar el borrado ARCO', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/api/organizations/${orgId}/contacts/${contactId}/erase`,
            headers: { authorization: `Bearer ${owner.jwt}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().success).toBe(true);
    });
});
