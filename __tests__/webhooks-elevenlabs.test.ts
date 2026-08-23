import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import crypto from 'crypto';
import supabasePlugin from '../src/plugins/supabase.js';
import { elevenLabsPostCallWebhookRoutes } from '../src/routes/webhooks/elevenlabs.js';
import { PROCESS_CALL_COMPLETED_QUEUE } from '../src/jobs/process-call-completed.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, getSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';

// Organización real existente (ver __tests__/entitlements.test.ts). En
// producción esta organización SÍ tiene webhook_token/webhook_signing_secret
// dados de alta (docs/tasks/elevenlabs-data-collection-key-mismatch.md) — los
// describe blocks de abajo capturan el valor original antes de pisarlo con
// uno de prueba y lo restauran en afterAll, en vez de hardcodear null/delete.
// Un afterAll que asume "esta org nunca tiene webhook configurado" borra
// silenciosamente el onboarding real cada vez que corre pnpm test completo.
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

async function buildTestApp() {
    const app = Fastify({ logger: false });

    // Réplica del parser de app.ts: preserva el cuerpo crudo, requerido por la
    // verificación de firma HMAC (misma razón documentada en src/app.ts).
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
        try {
            const raw = (body as Buffer).toString('utf8');
            (req as any).rawBody = raw;
            const json = raw.trim() ? JSON.parse(raw) : {};
            done(null, json);
        } catch (err: any) {
            err.statusCode = 400;
            done(err, undefined);
        }
    });

    await app.register(supabasePlugin);
    await app.register(elevenLabsPostCallWebhookRoutes);
    await app.ready();
    return app;
}

/**
 * Igual que `buildTestApp`, pero además decora `fastify.pgBoss` con un doble
 * de prueba (`send` espiable) — necesario para las pruebas que verifican el
 * encolado del trabajo sin depender de un pg-boss real corriendo.
 */
async function buildTestAppWithFakeQueue() {
    const sendSpy = vi.fn().mockResolvedValue('fake-pgboss-job-id');
    const fakeQueuePlugin = fp(async (fastify) => {
        fastify.decorate('pgBoss', { send: sendSpy } as any);
    });

    const app = Fastify({ logger: false });
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
        try {
            const raw = (body as Buffer).toString('utf8');
            (req as any).rawBody = raw;
            const json = raw.trim() ? JSON.parse(raw) : {};
            done(null, json);
        } catch (err: any) {
            err.statusCode = 400;
            done(err, undefined);
        }
    });

    await app.register(supabasePlugin);
    await app.register(fakeQueuePlugin);
    await app.register(elevenLabsPostCallWebhookRoutes);
    await app.ready();
    return { app, sendSpy };
}

function signPayload(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
    const signedPayload = `${timestamp}.${rawBody}`;
    const signature = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
    return `t=${timestamp},v0=${signature}`;
}

describe('2.1 — POST /webhooks/elevenlabs/:webhookToken', () => {
    // Requiere db/migrations/04_organizations_webhook_token.sql aplicada
    // (columna organizations.webhook_token).
    const TEST_WEBHOOK_TOKEN = `test-token-${crypto.randomUUID()}`;
    let originalWebhookToken: string | null = null;

    beforeAll(async () => {
        const { data: before } = await supabaseAdmin
            .from('organizations')
            .select('webhook_token')
            .eq('id', REAL_ORG_ID)
            .maybeSingle();
        originalWebhookToken = before?.webhook_token ?? null;

        const { error } = await supabaseAdmin
            .from('organizations')
            .update({ webhook_token: TEST_WEBHOOK_TOKEN })
            .eq('id', REAL_ORG_ID);
        // Falla explícita (no silenciosa) si falta aplicar
        // db/migrations/04_organizations_webhook_token.sql: sin esto, "org no
        // encontrada" y "org encontrada sin secreto" son indistinguibles (ambas
        // dan 401), y las pruebas de abajo pasarían por la razón equivocada.
        if (error) {
            throw new Error(`No se pudo preparar organizations.webhook_token para la prueba: ${error.message}`);
        }
    });

    afterAll(async () => {
        await supabaseAdmin.from('organizations').update({ webhook_token: originalWebhookToken }).eq('id', REAL_ORG_ID);
    });

    it('rechaza con 401 cuando el webhookToken de la ruta no resuelve a ninguna organización', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/webhooks/elevenlabs/token-inexistente-xyz',
                payload: { type: 'post_call_transcription', data: { conversation_id: 'conv_x' } },
            });
            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('resuelve la organización por el token de la ruta ANTES de necesitar campos del cuerpo, y aun así rechaza sin webhook_signing_secret configurado', async () => {
        const app = await buildTestApp();
        try {
            // El cuerpo ni siquiera trae agent_id: la resolución de tenant no depende de él.
            const response = await app.inject({
                method: 'POST',
                url: `/webhooks/elevenlabs/${TEST_WEBHOOK_TOKEN}`,
                payload: { type: 'post_call_transcription', data: { conversation_id: 'conv_x' } },
            });
            expect(response.statusCode).toBe(401);
            const body = response.json();
            expect(body.error).toBe('Unauthorized');
        } finally {
            await app.close();
        }
    });
});

describe('2.1 — Verificación de firma HMAC end-to-end (HTTP)', () => {
    const TEST_WEBHOOK_TOKEN = `sig-test-token-${crypto.randomUUID()}`;
    const SIGNING_SECRET = 'sig-e2e-test-secret-abc123';
    let originalWebhookToken: string | null = null;
    let originalSigningSecret: string | null = null;

    beforeAll(async () => {
        const { data: before } = await supabaseAdmin
            .from('organizations')
            .select('webhook_token')
            .eq('id', REAL_ORG_ID)
            .maybeSingle();
        originalWebhookToken = before?.webhook_token ?? null;
        originalSigningSecret = await getSecret(REAL_ORG_ID, SECRET_KEYS.WEBHOOK_SIGNING_SECRET);

        const { error } = await supabaseAdmin
            .from('organizations')
            .update({ webhook_token: TEST_WEBHOOK_TOKEN })
            .eq('id', REAL_ORG_ID);
        if (error) throw new Error(`No se pudo preparar webhook_token: ${error.message}`);

        const saved = await setSecret(REAL_ORG_ID, SECRET_KEYS.WEBHOOK_SIGNING_SECRET, SIGNING_SECRET);
        if (!saved) throw new Error('No se pudo guardar webhook_signing_secret de prueba');
        clearSecretCache(REAL_ORG_ID);
    });

    afterAll(async () => {
        await supabaseAdmin.from('organizations').update({ webhook_token: originalWebhookToken }).eq('id', REAL_ORG_ID);

        // Restaurar el valor original en vez de borrar sin condición: si la
        // organización ya tenía un webhook_signing_secret real antes de este
        // test (onboarding de producción), un DELETE incondicional lo pierde.
        if (originalSigningSecret !== null) {
            await setSecret(REAL_ORG_ID, SECRET_KEYS.WEBHOOK_SIGNING_SECRET, originalSigningSecret);
        } else {
            await supabaseAdmin
                .from('organization_secrets')
                .delete()
                .eq('organization_id', REAL_ORG_ID)
                .eq('secret_key', SECRET_KEYS.WEBHOOK_SIGNING_SECRET);
        }
        clearSecretCache(REAL_ORG_ID);
    });

    afterEach(async () => {
        // event_id tiene forma "<eventType>:<conversationId>" — conversationId
        // (que sí empieza con "sig-e2e-test:") queda en medio de la cadena, no
        // al inicio, de ahí el comodín en ambos lados.
        await supabaseAdmin.from('webhook_events').delete().eq('organization_id', REAL_ORG_ID).like('event_id', '%sig-e2e-test%');
    });

    it('rechaza con 401 una firma que no coincide, aunque haya secreto configurado (secreto incorrecto usado por el emisor)', async () => {
        const app = await buildTestApp();
        try {
            const rawBody = JSON.stringify({
                type: 'post_call_transcription',
                data: { conversation_id: 'sig-e2e-test:mismatch' },
            });
            const badSignature = signPayload(rawBody, 'secreto-equivocado-que-no-es-el-configurado');

            const response = await app.inject({
                method: 'POST',
                url: `/webhooks/elevenlabs/${TEST_WEBHOOK_TOKEN}`,
                headers: { 'content-type': 'application/json', 'elevenlabs-signature': badSignature },
                payload: rawBody,
            });

            expect(response.statusCode).toBe(401);
            expect(response.json().error).toBe('Unauthorized');
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: firma válida es aceptada, registra el evento y encola process-call-completed', async () => {
        const { app, sendSpy } = await buildTestAppWithFakeQueue();
        try {
            const conversationId = 'sig-e2e-test:valid';
            const rawBody = JSON.stringify({
                type: 'post_call_transcription',
                data: { conversation_id: conversationId },
            });
            const goodSignature = signPayload(rawBody, SIGNING_SECRET);

            const response = await app.inject({
                method: 'POST',
                url: `/webhooks/elevenlabs/${TEST_WEBHOOK_TOKEN}`,
                headers: { 'content-type': 'application/json', 'elevenlabs-signature': goodSignature },
                payload: rawBody,
            });

            expect(response.statusCode).toBe(200);
            expect(response.json().status).toBe('accepted');
            expect(sendSpy).toHaveBeenCalledTimes(1);
            expect(sendSpy).toHaveBeenCalledWith(
                PROCESS_CALL_COMPLETED_QUEUE,
                expect.objectContaining({ webhookEventId: expect.any(String) })
            );

            const { data: rows } = await supabaseAdmin
                .from('webhook_events')
                .select('id')
                .eq('organization_id', REAL_ORG_ID)
                .eq('event_id', `post_call_transcription:${conversationId}`);
            expect(rows?.length).toBe(1);
        } finally {
            await app.close();
        }
    });

    it('organización suspendida + firma válida → 403, sin insert en webhook_events ni job encolado', async () => {
        await supabaseAdmin.from('organizations').update({ status: 'suspended', suspended_reason: 'Prueba de suspensión' }).eq('id', REAL_ORG_ID);

        const { app, sendSpy } = await buildTestAppWithFakeQueue();
        try {
            const conversationId = 'sig-e2e-test:suspended';
            const rawBody = JSON.stringify({
                type: 'post_call_transcription',
                data: { conversation_id: conversationId },
            });
            const signature = signPayload(rawBody, SIGNING_SECRET);

            const response = await app.inject({
                method: 'POST',
                url: `/webhooks/elevenlabs/${TEST_WEBHOOK_TOKEN}`,
                headers: { 'content-type': 'application/json', 'elevenlabs-signature': signature },
                payload: rawBody,
            });

            expect(response.statusCode).toBe(403);
            expect(response.json().error).toBe('Forbidden');
            expect(sendSpy).not.toHaveBeenCalled();

            const { data: rows } = await supabaseAdmin
                .from('webhook_events')
                .select('id')
                .eq('organization_id', REAL_ORG_ID)
                .eq('event_id', `post_call_transcription:${conversationId}`);
            expect(rows?.length).toBe(0);
        } finally {
            await supabaseAdmin.from('organizations').update({ status: 'active', suspended_reason: null, suspended_at: null }).eq('id', REAL_ORG_ID);
            await app.close();
        }
    });

    it('idempotencia end-to-end: el mismo payload firmado entregado dos veces por HTTP solo encola el trabajo una vez', async () => {
        const { app, sendSpy } = await buildTestAppWithFakeQueue();
        try {
            const conversationId = 'sig-e2e-test:duplicate';
            const rawBody = JSON.stringify({
                type: 'post_call_transcription',
                data: { conversation_id: conversationId },
            });
            const signature = signPayload(rawBody, SIGNING_SECRET);

            const first = await app.inject({
                method: 'POST',
                url: `/webhooks/elevenlabs/${TEST_WEBHOOK_TOKEN}`,
                headers: { 'content-type': 'application/json', 'elevenlabs-signature': signature },
                payload: rawBody,
            });
            expect(first.statusCode).toBe(200);
            expect(first.json().status).toBe('accepted');

            const second = await app.inject({
                method: 'POST',
                url: `/webhooks/elevenlabs/${TEST_WEBHOOK_TOKEN}`,
                headers: { 'content-type': 'application/json', 'elevenlabs-signature': signature },
                payload: rawBody,
            });
            expect(second.statusCode).toBe(200);
            expect(second.json().status).toBe('duplicate');

            // El trabajo se encoló una sola vez: el segundo intento nunca llegó
            // a fastify.pgBoss.send porque el INSERT en webhook_events violó
            // la restricción única y la ruta responde 200 antes de encolar de nuevo.
            expect(sendSpy).toHaveBeenCalledTimes(1);

            const { data: rows } = await supabaseAdmin
                .from('webhook_events')
                .select('id')
                .eq('organization_id', REAL_ORG_ID)
                .eq('event_id', `post_call_transcription:${conversationId}`);
            expect(rows?.length).toBe(1);
        } finally {
            await app.close();
        }
    });
});

describe('2.1 — Idempotencia de entrega en webhook_events', () => {
    const TEST_EVENT_ID = `test:idempotencia:${Date.now()}`;

    afterEach(async () => {
        await supabaseAdmin.from('webhook_events').delete().eq('event_id', TEST_EVENT_ID);
    });

    it('el mismo (provider, event_id) entregado dos veces no produce dos filas', async () => {
        const first = await supabaseAdmin
            .from('webhook_events')
            .insert({
                organization_id: REAL_ORG_ID,
                provider: 'elevenlabs',
                event_id: TEST_EVENT_ID,
                event_type: 'post_call_transcription',
                raw_payload: { test: true },
            })
            .select('id')
            .single();

        expect(first.error).toBeNull();

        const second = await supabaseAdmin
            .from('webhook_events')
            .insert({
                organization_id: REAL_ORG_ID,
                provider: 'elevenlabs',
                event_id: TEST_EVENT_ID,
                event_type: 'post_call_transcription',
                raw_payload: { test: true },
            })
            .select('id')
            .single();

        // webhook_events_provider_event_id_key: UNIQUE (provider, event_id), ya existente en el esquema.
        expect(second.error).not.toBeNull();
        expect(second.error?.code).toBe('23505');

        const { data: rows } = await supabaseAdmin
            .from('webhook_events')
            .select('id')
            .eq('event_id', TEST_EVENT_ID);

        expect(rows?.length).toBe(1);
    });
});

/**
 * FASE B.3 (docs/tasks/catalogo-productos-grupos-cred.md): workspace
 * compartido. Requiere db/migrations/57_credential_group_webhook_token.sql
 * aplicada (columna credential_groups.webhook_token) — sin ella, este
 * describe entero falla en beforeAll con un error explícito (columna
 * inexistente), nunca en silencio.
 */
describe('2.1 / B.3 — POST /webhooks/elevenlabs/:webhookToken con workspace compartido (grupo de credenciales)', () => {
    const GROUP_WEBHOOK_TOKEN = `group-token-${crypto.randomUUID()}`;
    const GROUP_SIGNING_SECRET = 'group-e2e-test-secret-xyz789';
    const OWNER_AGENT_ID = `agent-owner-${crypto.randomUUID()}`;
    const MEMBER_AGENT_ID = `agent-member-${crypto.randomUUID()}`;
    const OUTSIDE_AGENT_ID = `agent-outside-${crypto.randomUUID()}`;

    let groupId: string;
    let ownerOrgId: string;
    let memberOrgId: string;
    let outsideOrgId: string;

    beforeAll(async () => {
        const { data: group, error: groupErr } = await supabaseAdmin
            .from('credential_groups')
            .insert({ name: 'Grupo compartido (webhooks-elevenlabs.test.ts)' })
            .select('id')
            .single();
        if (groupErr || !group) throw new Error(`No se pudo crear credential_groups de prueba: ${groupErr?.message}`);
        groupId = group.id;

        const { data: owner, error: ownerErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Owner grupo compartido (webhooks-elevenlabs.test.ts)',
                email: `owner-shared-webhook-test-${Date.now()}@example.invalid`,
                credential_group_id: groupId,
                elevenlabs_agent_id: OWNER_AGENT_ID,
            })
            .select('id')
            .single();
        if (ownerErr || !owner) throw new Error(`No se pudo crear la organización owner: ${ownerErr?.message}`);
        ownerOrgId = owner.id;

        const { error: groupUpdateErr } = await supabaseAdmin
            .from('credential_groups')
            .update({ owner_organization_id: ownerOrgId, webhook_token: GROUP_WEBHOOK_TOKEN })
            .eq('id', groupId);
        if (groupUpdateErr) throw new Error(`No se pudo configurar owner/webhook_token del grupo: ${groupUpdateErr.message}`);

        const { data: member, error: memberErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Miembro grupo compartido (webhooks-elevenlabs.test.ts)',
                email: `member-shared-webhook-test-${Date.now()}@example.invalid`,
                credential_group_id: groupId,
                elevenlabs_agent_id: MEMBER_AGENT_ID,
            })
            .select('id')
            .single();
        if (memberErr || !member) throw new Error(`No se pudo crear la organización miembro: ${memberErr?.message}`);
        memberOrgId = member.id;

        // Organización FUERA del grupo, con su propio agent_id — usada para
        // probar el rechazo de "agent_id no pertenece a este grupo".
        const { data: outside, error: outsideErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Fuera del grupo (webhooks-elevenlabs.test.ts)',
                email: `outside-shared-webhook-test-${Date.now()}@example.invalid`,
                elevenlabs_agent_id: OUTSIDE_AGENT_ID,
            })
            .select('id')
            .single();
        if (outsideErr || !outside) throw new Error(`No se pudo crear la organización fuera del grupo: ${outsideErr?.message}`);
        outsideOrgId = outside.id;

        const saved = await setSecret(ownerOrgId, SECRET_KEYS.WEBHOOK_SIGNING_SECRET, GROUP_SIGNING_SECRET);
        if (!saved) throw new Error('No se pudo guardar webhook_signing_secret del grupo de prueba');
        clearSecretCache(ownerOrgId);
    });

    afterAll(async () => {
        await supabaseAdmin.from('webhook_events').delete().in('organization_id', [ownerOrgId, memberOrgId, outsideOrgId].filter(Boolean));
        if (outsideOrgId) await supabaseAdmin.from('organizations').delete().eq('id', outsideOrgId);
        if (memberOrgId) await supabaseAdmin.from('organizations').delete().eq('id', memberOrgId);
        if (ownerOrgId) await supabaseAdmin.from('organizations').delete().eq('id', ownerOrgId);
        if (groupId) await supabaseAdmin.from('credential_groups').delete().eq('id', groupId);
    });

    it('la firma se verifica ANTES de leer agent_id del cuerpo: firma inválida rechaza con 401 aunque el cuerpo ni siquiera traiga agent_id', async () => {
        const app = await buildTestApp();
        try {
            const rawBody = JSON.stringify({ type: 'post_call_transcription', data: { conversation_id: 'shared-webhook-test:no-agent-id' } });
            const badSignature = signPayload(rawBody, 'secreto-que-no-es-el-del-grupo');

            const response = await app.inject({
                method: 'POST',
                url: `/webhooks/elevenlabs/${GROUP_WEBHOOK_TOKEN}`,
                headers: { 'content-type': 'application/json', 'elevenlabs-signature': badSignature },
                payload: rawBody,
            });

            expect(response.statusCode).toBe(401);
            expect(response.json().error).toBe('Unauthorized');
            expect(response.json().message).not.toContain('agent_id');
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: firma válida + agent_id de un MIEMBRO no-owner del grupo resuelve esa organización y encola el trabajo', async () => {
        const { app, sendSpy } = await buildTestAppWithFakeQueue();
        try {
            const conversationId = 'shared-webhook-test:member-valid';
            const rawBody = JSON.stringify({
                type: 'post_call_transcription',
                data: { conversation_id: conversationId, agent_id: MEMBER_AGENT_ID },
            });
            const goodSignature = signPayload(rawBody, GROUP_SIGNING_SECRET);

            const response = await app.inject({
                method: 'POST',
                url: `/webhooks/elevenlabs/${GROUP_WEBHOOK_TOKEN}`,
                headers: { 'content-type': 'application/json', 'elevenlabs-signature': goodSignature },
                payload: rawBody,
            });

            expect(response.statusCode).toBe(200);
            expect(response.json().status).toBe('accepted');
            expect(sendSpy).toHaveBeenCalledTimes(1);

            const { data: rows } = await supabaseAdmin
                .from('webhook_events')
                .select('id, organization_id')
                .eq('event_id', `post_call_transcription:${conversationId}`);
            expect(rows?.length).toBe(1);
            expect(rows?.[0].organization_id).toBe(memberOrgId);
        } finally {
            await app.close();
        }
    });

    it('agent_id que no pertenece a NINGUNA organización se rechaza con 401', async () => {
        const app = await buildTestApp();
        try {
            const rawBody = JSON.stringify({
                type: 'post_call_transcription',
                data: { conversation_id: 'shared-webhook-test:agent-inexistente', agent_id: `agent-no-existe-${crypto.randomUUID()}` },
            });
            const signature = signPayload(rawBody, GROUP_SIGNING_SECRET);

            const response = await app.inject({
                method: 'POST',
                url: `/webhooks/elevenlabs/${GROUP_WEBHOOK_TOKEN}`,
                headers: { 'content-type': 'application/json', 'elevenlabs-signature': signature },
                payload: rawBody,
            });

            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('agent_id de una organización REAL pero de OTRO grupo se rechaza con 401 (no basta con que exista, debe pertenecer a este grupo)', async () => {
        const app = await buildTestApp();
        try {
            const rawBody = JSON.stringify({
                type: 'post_call_transcription',
                data: { conversation_id: 'shared-webhook-test:agent-fuera-del-grupo', agent_id: OUTSIDE_AGENT_ID },
            });
            const signature = signPayload(rawBody, GROUP_SIGNING_SECRET);

            const response = await app.inject({
                method: 'POST',
                url: `/webhooks/elevenlabs/${GROUP_WEBHOOK_TOKEN}`,
                headers: { 'content-type': 'application/json', 'elevenlabs-signature': signature },
                payload: rawBody,
            });

            expect(response.statusCode).toBe(401);

            const { data: rows } = await supabaseAdmin
                .from('webhook_events')
                .select('id')
                .eq('organization_id', outsideOrgId)
                .eq('event_id', 'post_call_transcription:shared-webhook-test:agent-fuera-del-grupo');
            expect(rows?.length ?? 0).toBe(0);
        } finally {
            await app.close();
        }
    });

    it('el owner del grupo (agent_id propio) también resuelve correctamente — no es un caso especial frente a un miembro', async () => {
        const { app, sendSpy } = await buildTestAppWithFakeQueue();
        try {
            const conversationId = 'shared-webhook-test:owner-valid';
            const rawBody = JSON.stringify({
                type: 'post_call_transcription',
                data: { conversation_id: conversationId, agent_id: OWNER_AGENT_ID },
            });
            const signature = signPayload(rawBody, GROUP_SIGNING_SECRET);

            const response = await app.inject({
                method: 'POST',
                url: `/webhooks/elevenlabs/${GROUP_WEBHOOK_TOKEN}`,
                headers: { 'content-type': 'application/json', 'elevenlabs-signature': signature },
                payload: rawBody,
            });

            expect(response.statusCode).toBe(200);
            expect(sendSpy).toHaveBeenCalledTimes(1);

            const { data: rows } = await supabaseAdmin
                .from('webhook_events')
                .select('organization_id')
                .eq('event_id', `post_call_transcription:${conversationId}`);
            expect(rows?.[0]?.organization_id).toBe(ownerOrgId);
        } finally {
            await app.close();
        }
    });
});
