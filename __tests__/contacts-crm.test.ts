import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { validateEnv } from '../src/config/env.js';
import supabasePlugin from '../src/plugins/supabase.js';
import contactsCrmRoutes from '../src/routes/contacts-crm.js';
import { APPOINTMENT_STATUSES } from '../src/types/appointment-status.js';

const env = validateEnv();

async function buildTestApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(contactsCrmRoutes);
    await app.ready();
    return app;
}

interface TestUser {
    userId: string;
    jwt: string;
}

// Mismo patrón que __tests__/contacts.test.ts: JWT real vía signInWithPassword.
async function createTestUserWithJwt(): Promise<TestUser> {
    const email = `test-crm-${crypto.randomUUID()}@example.invalid`;
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

describe('routes/contacts-crm.ts — CRM de contactos (Fase D/E)', () => {
    let owner: TestUser;
    let member: TestUser; // role 'member', pertenece a la org pero sin permiso de merge
    let outsider: TestUser; // no pertenece a la org
    let orgId: string;
    let normalContactId: string;
    let optedOutContactId: string;

    beforeAll(async () => {
        owner = await createTestUserWithJwt();
        member = await createTestUserWithJwt();
        outsider = await createTestUserWithJwt();

        const { data: org, error } = await supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: 'CRM Test Org',
            p_email: `crm-test-${crypto.randomUUID()}@example.invalid`,
            p_phone_number: null,
            p_user_id: owner.userId,
        });
        if (error || !org) throw new Error(`Setup falló creando organización: ${error?.message}`);
        orgId = org.id;

        const { error: memberErr } = await supabaseAdmin.from('organization_members').insert({ organization_id: orgId, user_id: member.userId, role: 'member' });
        if (memberErr) throw new Error(`Setup falló agregando member: ${memberErr.message}`);

        const { data: normalContact, error: contactErr } = await supabaseAdmin.rpc('resolve_contact', {
            p_org_id: orgId,
            p_phone: randomMxPhone(),
            p_email: null,
        });
        if (contactErr || !normalContact) throw new Error(`Setup falló creando contacto: ${contactErr?.message}`);
        normalContactId = normalContact;

        const { data: optedOutContact, error: optedOutErr } = await supabaseAdmin.rpc('resolve_contact', {
            p_org_id: orgId,
            p_phone: randomMxPhone(),
            p_email: null,
        });
        if (optedOutErr || !optedOutContact) throw new Error(`Setup falló creando contacto opted_out: ${optedOutErr?.message}`);
        optedOutContactId = optedOutContact;
        await supabaseAdmin.from('contacts').update({ opted_out: true, opted_out_at: new Date().toISOString() }).eq('id', optedOutContactId);
    });

    afterAll(async () => {
        await supabaseAdmin.from('contact_notes').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('appointments').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('contact_addresses').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('leads').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('contacts').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organization_members').delete().eq('organization_id', orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        await deleteTestUser(owner.userId);
        await deleteTestUser(member.userId);
        await deleteTestUser(outsider.userId);
    });

    // -------------------------------------------------------------------
    // PATCH /contacts/:contactId
    // -------------------------------------------------------------------
    describe('PATCH /api/organizations/:id/contacts/:contactId', () => {
        it('sin JWT → 401', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({ method: 'PATCH', url: `/api/organizations/${orgId}/contacts/${normalContactId}`, payload: { fullName: 'X' } });
                expect(res.statusCode).toBe(401);
            } finally {
                await app.close();
            }
        });

        it('outsider sin membresía → 403', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}`,
                    headers: { authorization: `Bearer ${outsider.jwt}` },
                    payload: { fullName: 'X' },
                });
                expect(res.statusCode).toBe(403);
            } finally {
                await app.close();
            }
        });

        it('contacto opted_out → 403, bloqueado en servidor', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/contacts/${optedOutContactId}`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { fullName: 'No Debería Guardarse' },
                });
                expect(res.statusCode).toBe(403);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: miembro actualiza el perfil del contacto', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { fullName: 'Cliente Actualizado', businessName: 'Negocio X' },
                });
                expect(res.statusCode).toBe(200);
                expect(res.json().data.full_name).toBe('Cliente Actualizado');
                expect(res.json().data.business_name).toBe('Negocio X');
            } finally {
                await app.close();
            }
        });
    });

    // -------------------------------------------------------------------
    // PATCH /contacts/:contactId/pipeline
    // -------------------------------------------------------------------
    describe('PATCH /api/organizations/:id/contacts/:contactId/pipeline', () => {
        it('pipelineStage="perdido" sin lostReason → 400', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/pipeline`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { pipelineStage: 'perdido' },
                });
                expect(res.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('pipelineStage inválido (fuera del enum) → 400', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/pipeline`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { pipelineStage: 'no_existe' },
                });
                expect(res.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: pipelineStage="perdido" con lostReason marca lifecycle_stage="descartado"', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/pipeline`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { pipelineStage: 'perdido', lostReason: 'No respondió' },
                });
                expect(res.statusCode).toBe(200);
                const data = res.json().data;
                expect(data.pipeline_stage).toBe('perdido');
                expect(data.lifecycle_stage).toBe('descartado');
                expect(data.lost_reason).toBe('No respondió');
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: pipelineStage="ganado" marca lifecycle_stage="cliente" y fija won_at', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/pipeline`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { pipelineStage: 'ganado' },
                });
                expect(res.statusCode).toBe(200);
                const data = res.json().data;
                expect(data.pipeline_stage).toBe('ganado');
                expect(data.lifecycle_stage).toBe('cliente');
                expect(data.won_at).toBeTruthy();
            } finally {
                await app.close();
            }
        });

        it('reabrir a una etapa activa después de "ganado" vuelve lifecycle_stage a "prospecto" (coherente con el CHECK)', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/pipeline`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { pipelineStage: 'contactado' },
                });
                expect(res.statusCode).toBe(200);
                const data = res.json().data;
                expect(data.pipeline_stage).toBe('contactado');
                expect(data.lifecycle_stage).toBe('prospecto');
                expect(data.won_at).toBeNull();
            } finally {
                await app.close();
            }
        });

        it('C.1 — dealValue con pipelineStage distinto de "ganado" → 400', async () => {
            const { data: contactId } = await supabaseAdmin.rpc('resolve_contact', { p_org_id: orgId, p_phone: randomMxPhone(), p_email: null });
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/contacts/${contactId}/pipeline`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { pipelineStage: 'contactado', dealValue: 1500 },
                });
                expect(res.statusCode).toBe(400);
            } finally {
                await supabaseAdmin.from('contacts').delete().eq('id', contactId);
                await app.close();
            }
        });

        it('C.1 — contraparte de éxito: pipelineStage="ganado" con dealValue/dealCurrency/dealNotes los persiste', async () => {
            const { data: contactId } = await supabaseAdmin.rpc('resolve_contact', { p_org_id: orgId, p_phone: randomMxPhone(), p_email: null });
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/contacts/${contactId}/pipeline`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { pipelineStage: 'ganado', dealValue: 2500.5, dealCurrency: 'USD', dealNotes: 'Paquete anual' },
                });
                expect(res.statusCode).toBe(200);
                const data = res.json().data;
                expect(data.pipeline_stage).toBe('ganado');
                expect(data.deal_value).toBe(2500.5);
                expect(data.deal_currency).toBe('USD');
                expect(data.deal_notes).toBe('Paquete anual');
            } finally {
                await supabaseAdmin.from('contacts').delete().eq('id', contactId);
                await app.close();
            }
        });

        it('C.1 — contraparte de éxito: pipelineStage="ganado" SIN dealValue sigue funcionando (el monto es opcional)', async () => {
            const { data: contactId } = await supabaseAdmin.rpc('resolve_contact', { p_org_id: orgId, p_phone: randomMxPhone(), p_email: null });
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/contacts/${contactId}/pipeline`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { pipelineStage: 'ganado' },
                });
                expect(res.statusCode).toBe(200);
                expect(res.json().data.pipeline_stage).toBe('ganado');
            } finally {
                await supabaseAdmin.from('contacts').delete().eq('id', contactId);
                await app.close();
            }
        });
    });

    // -------------------------------------------------------------------
    // POST /contacts/:contactId/notes
    // -------------------------------------------------------------------
    describe('POST /api/organizations/:id/contacts/:contactId/notes', () => {
        it('body vacío → 400', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/notes`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: {},
                });
                expect(res.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: crea la nota con el autor correcto', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/notes`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { body: 'Nota de prueba del equipo.' },
                });
                expect(res.statusCode).toBe(201);
                expect(res.json().data.body).toBe('Nota de prueba del equipo.');
                expect(res.json().data.author_user_id).toBe(owner.userId);
            } finally {
                await app.close();
            }
        });
    });

    // -------------------------------------------------------------------
    // Direcciones: GET/POST/PATCH/DELETE
    // -------------------------------------------------------------------
    describe('Direcciones de contacto', () => {
        it('POST contraparte de éxito: crea una dirección nueva (primera → is_primary=true automático)', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/addresses`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { street: 'Av. Primera Dirección 1', city: 'CDMX', label: 'Casa' },
                });
                expect(res.statusCode).toBe(201);
                expect(res.json().data.street).toBe('Av. Primera Dirección 1');
                expect(res.json().data.label).toBe('Casa');
                expect(res.json().data.is_primary).toBe(true);
            } finally {
                await app.close();
            }
        });

        it('GET contraparte de éxito: lista las direcciones activas del contacto', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/addresses`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(res.statusCode).toBe(200);
                expect(res.json().data.length).toBeGreaterThanOrEqual(1);
            } finally {
                await app.close();
            }
        });

        it('PATCH con un addressId inexistente → 404', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/addresses/00000000-0000-0000-0000-000000000000`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { city: 'Guadalajara' },
                });
                expect(res.statusCode).toBe(404);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: PATCH marca una segunda dirección como principal y desmarca la anterior', async () => {
            const app = await buildTestApp();
            try {
                const second = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/addresses`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { street: 'Av. Segunda Dirección 2', city: 'CDMX' },
                });
                expect(second.statusCode).toBe(201);
                expect(second.json().data.is_primary).toBe(false);
                const secondId = second.json().data.id;

                const patch = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/addresses/${secondId}`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { isPrimary: true },
                });
                expect(patch.statusCode).toBe(200);
                expect(patch.json().data.is_primary).toBe(true);

                const { data: allAddresses } = await supabaseAdmin.from('contact_addresses').select('id, is_primary').eq('contact_id', normalContactId).is('archived_at', null);
                const primaryOnes = (allAddresses ?? []).filter((a) => a.is_primary);
                expect(primaryOnes).toHaveLength(1);
                expect(primaryOnes[0].id).toBe(secondId);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: DELETE archiva la dirección (no la borra) y deja de listarse', async () => {
            const app = await buildTestApp();
            try {
                const created = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/addresses`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { street: 'Av. Para Archivar 3' },
                });
                const addressId = created.json().data.id;

                const del = await app.inject({
                    method: 'DELETE',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/addresses/${addressId}`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(del.statusCode).toBe(200);

                const { data: row } = await supabaseAdmin.from('contact_addresses').select('archived_at').eq('id', addressId).single();
                expect(row?.archived_at).not.toBeNull();

                const list = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}/addresses`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(list.json().data.map((a: { id: string }) => a.id)).not.toContain(addressId);
            } finally {
                await app.close();
            }
        });

        it('direcciones sobre un contacto opted_out → 403 en escritura', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/contacts/${optedOutContactId}/addresses`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { street: 'No Debería Crearse' },
                });
                expect(res.statusCode).toBe(403);
            } finally {
                await app.close();
            }
        });
    });

    // -------------------------------------------------------------------
    // PATCH /appointments/:appointmentId/status
    // -------------------------------------------------------------------
    describe('PATCH /api/organizations/:id/appointments/:appointmentId/status', () => {
        let appointmentId: string;

        beforeAll(async () => {
            const { data, error } = await supabaseAdmin
                .from('appointments')
                .insert({
                    organization_id: orgId,
                    contact_id: normalContactId,
                    customer_name: 'Cliente Cita CRM',
                    customer_phone: randomMxPhone(),
                    start_time: new Date(Date.now() + 86400000).toISOString(),
                    end_time: new Date(Date.now() + 90000000).toISOString(),
                    status: APPOINTMENT_STATUSES.CONFIRMADA,
                })
                .select('id')
                .single();
            if (error || !data) throw new Error(`Setup falló creando cita: ${error?.message}`);
            appointmentId = data.id;
        });

        it('status inválido (fuera del vocabulario de appointments_status_check) → 400', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/appointments/${appointmentId}/status`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { status: 'inventado' },
                });
                expect(res.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('appointmentId inexistente en la organización → 404', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/appointments/00000000-0000-0000-0000-000000000000/status`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { status: APPOINTMENT_STATUSES.CANCELADA },
                });
                expect(res.statusCode).toBe(404);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: cambia el estado de la cita a "cancelada"', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/appointments/${appointmentId}/status`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { status: APPOINTMENT_STATUSES.CANCELADA },
                });
                expect(res.statusCode).toBe(200);
                expect(res.json().data.status).toBe(APPOINTMENT_STATUSES.CANCELADA);
            } finally {
                await app.close();
            }
        });

        it('B.1 — el cambio exitoso registra status_updated_at y status_updated_by (el usuario que hizo el PATCH)', async () => {
            const { data: cita } = await supabaseAdmin
                .from('appointments')
                .insert({
                    organization_id: orgId,
                    contact_id: normalContactId,
                    customer_name: 'Cita Para Auditoría',
                    customer_phone: randomMxPhone(),
                    start_time: new Date(Date.now() + 86400000).toISOString(),
                    end_time: new Date(Date.now() + 90000000).toISOString(),
                    status: APPOINTMENT_STATUSES.PROGRAMADA,
                })
                .select('id')
                .single();

            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/appointments/${cita!.id}/status`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { status: APPOINTMENT_STATUSES.CONFIRMADA },
                });
                expect(res.statusCode).toBe(200);
                expect(res.json().data.status_updated_by).toBe(owner.userId);
                expect(res.json().data.status_updated_at).toBeTruthy();
            } finally {
                await supabaseAdmin.from('appointments').delete().eq('id', cita!.id);
                await app.close();
            }
        });

        it('B.1 — bloqueo de fecha futura: marcar "completada" en una cita que todavía no ocurre → 400', async () => {
            const { data: citaFutura } = await supabaseAdmin
                .from('appointments')
                .insert({
                    organization_id: orgId,
                    contact_id: normalContactId,
                    customer_name: 'Cita Futura',
                    customer_phone: randomMxPhone(),
                    start_time: new Date(Date.now() + 86400000).toISOString(),
                    end_time: new Date(Date.now() + 90000000).toISOString(),
                    status: APPOINTMENT_STATUSES.CONFIRMADA,
                })
                .select('id')
                .single();

            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/appointments/${citaFutura!.id}/status`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { status: APPOINTMENT_STATUSES.COMPLETADA },
                });
                expect(res.statusCode).toBe(400);
            } finally {
                await supabaseAdmin.from('appointments').delete().eq('id', citaFutura!.id);
                await app.close();
            }
        });

        it('B.1 — contraparte de éxito: marcar "no_asistio" en una cita YA pasada sí funciona, con noShowReason', async () => {
            const { data: citaPasada } = await supabaseAdmin
                .from('appointments')
                .insert({
                    organization_id: orgId,
                    contact_id: normalContactId,
                    customer_name: 'Cita Pasada',
                    customer_phone: randomMxPhone(),
                    start_time: new Date(Date.now() - 86400000).toISOString(),
                    end_time: new Date(Date.now() - 82800000).toISOString(),
                    status: APPOINTMENT_STATUSES.CONFIRMADA,
                })
                .select('id')
                .single();

            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/appointments/${citaPasada!.id}/status`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { status: APPOINTMENT_STATUSES.NO_ASISTIO, noShowReason: 'No contestó ni avisó' },
                });
                expect(res.statusCode).toBe(200);
                expect(res.json().data.status).toBe(APPOINTMENT_STATUSES.NO_ASISTIO);
                expect(res.json().data.no_show_reason).toBe('No contestó ni avisó');
            } finally {
                await supabaseAdmin.from('appointments').delete().eq('id', citaPasada!.id);
                await app.close();
            }
        });

        it('B.1 — matriz de transición: desde un estado FINAL (cancelada) solo se permite pasar a "reprogramada" → cualquier otro destino es 400', async () => {
            const { data: citaCancelada } = await supabaseAdmin
                .from('appointments')
                .insert({
                    organization_id: orgId,
                    contact_id: normalContactId,
                    customer_name: 'Cita Ya Cancelada',
                    customer_phone: randomMxPhone(),
                    start_time: new Date(Date.now() + 86400000).toISOString(),
                    end_time: new Date(Date.now() + 90000000).toISOString(),
                    status: APPOINTMENT_STATUSES.CANCELADA,
                })
                .select('id')
                .single();

            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/appointments/${citaCancelada!.id}/status`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { status: APPOINTMENT_STATUSES.CONFIRMADA },
                });
                expect(res.statusCode).toBe(400);
            } finally {
                await supabaseAdmin.from('appointments').delete().eq('id', citaCancelada!.id);
                await app.close();
            }
        });

        it('B.1 — contraparte de éxito: desde un estado FINAL (cancelada) sí se permite pasar a "reprogramada"', async () => {
            const { data: citaCancelada } = await supabaseAdmin
                .from('appointments')
                .insert({
                    organization_id: orgId,
                    contact_id: normalContactId,
                    customer_name: 'Cita Cancelada Para Reagendar',
                    customer_phone: randomMxPhone(),
                    start_time: new Date(Date.now() + 86400000).toISOString(),
                    end_time: new Date(Date.now() + 90000000).toISOString(),
                    status: APPOINTMENT_STATUSES.CANCELADA,
                })
                .select('id')
                .single();

            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/appointments/${citaCancelada!.id}/status`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { status: APPOINTMENT_STATUSES.REPROGRAMADA },
                });
                expect(res.statusCode).toBe(200);
                expect(res.json().data.status).toBe(APPOINTMENT_STATUSES.REPROGRAMADA);
            } finally {
                await supabaseAdmin.from('appointments').delete().eq('id', citaCancelada!.id);
                await app.close();
            }
        });

        it('B.1 — contraparte de éxito: desde un estado NO final (programada) se permite pasar a cualquier destino', async () => {
            const { data: citaProgramada } = await supabaseAdmin
                .from('appointments')
                .insert({
                    organization_id: orgId,
                    contact_id: normalContactId,
                    customer_name: 'Cita Programada Libre',
                    customer_phone: randomMxPhone(),
                    start_time: new Date(Date.now() + 86400000).toISOString(),
                    end_time: new Date(Date.now() + 90000000).toISOString(),
                    status: APPOINTMENT_STATUSES.PROGRAMADA,
                })
                .select('id')
                .single();

            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'PATCH',
                    url: `/api/organizations/${orgId}/appointments/${citaProgramada!.id}/status`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { status: APPOINTMENT_STATUSES.CANCELADA },
                });
                expect(res.statusCode).toBe(200);
                expect(res.json().data.status).toBe(APPOINTMENT_STATUSES.CANCELADA);
            } finally {
                await supabaseAdmin.from('appointments').delete().eq('id', citaProgramada!.id);
                await app.close();
            }
        });
    });

    // -------------------------------------------------------------------
    // GET /contacts/duplicates
    // -------------------------------------------------------------------
    describe('GET /api/organizations/:id/contacts/duplicates', () => {
        it('contraparte de éxito: detecta un par de contactos que comparten correo', async () => {
            const sharedEmail = `dup-crm-${Date.now()}@example.invalid`;
            const { data: dupA } = await supabaseAdmin.rpc('resolve_contact', { p_org_id: orgId, p_phone: randomMxPhone(), p_email: sharedEmail });
            const { data: dupB } = await supabaseAdmin.rpc('resolve_contact', { p_org_id: orgId, p_phone: randomMxPhone(), p_email: sharedEmail });

            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgId}/contacts/duplicates`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(res.statusCode).toBe(200);
                const pairs = res.json().data as Array<{ contact_a: string; contact_b: string }>;
                const found = pairs.some((p) => [p.contact_a, p.contact_b].includes(dupA) && [p.contact_a, p.contact_b].includes(dupB));
                expect(found).toBe(true);
            } finally {
                await supabaseAdmin.from('contacts').delete().in('id', [dupA, dupB]);
                await app.close();
            }
        });
    });

    // -------------------------------------------------------------------
    // POST /contacts/merge
    // -------------------------------------------------------------------
    describe('POST /api/organizations/:id/contacts/merge', () => {
        it('rol "member" (no admin/owner) → 403', async () => {
            const { data: keepId } = await supabaseAdmin.rpc('resolve_contact', { p_org_id: orgId, p_phone: randomMxPhone(), p_email: null });
            const { data: absorbId } = await supabaseAdmin.rpc('resolve_contact', { p_org_id: orgId, p_phone: randomMxPhone(), p_email: null });

            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/contacts/merge`,
                    headers: { authorization: `Bearer ${member.jwt}` },
                    payload: { keepContactId: keepId, absorbContactId: absorbId },
                });
                expect(res.statusCode).toBe(403);
            } finally {
                await supabaseAdmin.from('contacts').delete().in('id', [keepId, absorbId]);
                await app.close();
            }
        });

        it('keepContactId igual a absorbContactId → 400', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/contacts/merge`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { keepContactId: normalContactId, absorbContactId: normalContactId },
                });
                expect(res.statusCode).toBe(400);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: owner fusiona dos contactos con direcciones duplicadas sin error', async () => {
            const { data: keepId } = await supabaseAdmin.rpc('resolve_contact', { p_org_id: orgId, p_phone: randomMxPhone(), p_email: null });
            const { data: absorbId } = await supabaseAdmin.rpc('resolve_contact', { p_org_id: orgId, p_phone: randomMxPhone(), p_email: null });

            // Misma dirección (mismo dedupe_key) en ambos contactos — el
            // escenario de "fusión con direcciones duplicadas" que pide la tarea.
            await supabaseAdmin.rpc('resolve_contact_address', { p_org_id: orgId, p_contact_id: keepId, p_street: 'Calle Duplicada En Ambos 99', p_city: 'CDMX' });
            await supabaseAdmin.rpc('resolve_contact_address', { p_org_id: orgId, p_contact_id: absorbId, p_street: 'Calle Duplicada En Ambos 99', p_city: 'CDMX' });

            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/contacts/merge`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { keepContactId: keepId, absorbContactId: absorbId },
                });
                expect(res.statusCode).toBe(200);
                expect(res.json().data.id).toBe(keepId);

                const { data: absorbAfter } = await supabaseAdmin.from('contacts').select('archived_at').eq('id', absorbId).single();
                expect(absorbAfter?.archived_at).not.toBeNull();
            } finally {
                await supabaseAdmin.from('contact_addresses').delete().in('contact_id', [keepId, absorbId]);
                await supabaseAdmin.from('contacts').delete().in('id', [keepId, absorbId]);
                await app.close();
            }
        });

        it('un contacto que no pertenece a la organización → 404', async () => {
            const { data: otherOrg } = await supabaseAdmin.from('organizations').insert({ name: 'Otra Org Merge', email: `otra-org-merge-${Date.now()}@example.invalid` }).select('id').single();
            const { data: foreignContact } = await supabaseAdmin.rpc('resolve_contact', { p_org_id: otherOrg!.id, p_phone: randomMxPhone(), p_email: null });

            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'POST',
                    url: `/api/organizations/${orgId}/contacts/merge`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                    payload: { keepContactId: normalContactId, absorbContactId: foreignContact },
                });
                expect(res.statusCode).toBe(404);
            } finally {
                await supabaseAdmin.from('contacts').delete().eq('id', foreignContact);
                await supabaseAdmin.from('organizations').delete().eq('id', otherOrg!.id);
                await app.close();
            }
        });
    });

    // -------------------------------------------------------------------
    // GET /pipeline
    // -------------------------------------------------------------------
    describe('GET /api/organizations/:id/pipeline', () => {
        it('contraparte de éxito: devuelve el contacto de prueba en el kanban', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgId}/pipeline`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(res.statusCode).toBe(200);
                const ids = (res.json().data as Array<{ id: string }>).map((r) => r.id);
                expect(ids).toContain(normalContactId);
            } finally {
                await app.close();
            }
        });
    });

    // -------------------------------------------------------------------
    // GET /contacts/:contactId (detalle + timeline)
    // -------------------------------------------------------------------
    describe('GET /api/organizations/:id/contacts/:contactId', () => {
        it('contactId inexistente → 404', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgId}/contacts/00000000-0000-0000-0000-000000000000`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(res.statusCode).toBe(404);
            } finally {
                await app.close();
            }
        });

        it('contraparte de éxito: devuelve contacto, direcciones y timeline unificado (nota + cita)', async () => {
            const app = await buildTestApp();
            try {
                const res = await app.inject({
                    method: 'GET',
                    url: `/api/organizations/${orgId}/contacts/${normalContactId}`,
                    headers: { authorization: `Bearer ${owner.jwt}` },
                });
                expect(res.statusCode).toBe(200);
                const body = res.json().data;
                expect(body.contact.id).toBe(normalContactId);
                expect(Array.isArray(body.addresses)).toBe(true);
                expect(Array.isArray(body.timeline)).toBe(true);
                expect(body.timeline.some((entry: { type: string }) => entry.type === 'note')).toBe(true);
                expect(body.timeline.some((entry: { type: string }) => entry.type === 'appointment')).toBe(true);
            } finally {
                await app.close();
            }
        });
    });
});
