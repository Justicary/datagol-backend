import crypto from 'crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuthenticatedUser, requireOrganizationMembership } from '../lib/organization-auth.js';
import { setSecret, listSecretStatus } from '../services/secret-service.js';
import { SECRET_KEYS, type SecretKey } from '../types/secret-keys.js';
import { setOrganizationPlan, checkProviderCredentials, getOrganizationFeatures } from '../services/entitlements.js';
import { reprovisionAgent } from '../services/agent-provisioning.js';
import {
    organizationIdParamsSchema,
    createOrganizationBodySchema,
    createOrganizationResponseSchema,
    businessInfoBodySchema,
    planBodySchema,
    credentialsBodySchema,
    credentialsStatusResponseSchema,
    tokensResponseSchema,
    readinessResponseSchema,
    type CredentialProvider,
} from '../schemas/organization-onboarding.js';

/**
 * Endpoints de onboarding de organización (self-service DFY).
 * Ver docs/tasks/onboarding-endpoints.md — reemplaza el legacy
 * `POST /api/organizations/onboard` de `routes/organization.ts`.
 *
 * Patrón de autenticación/pertenencia (decisión de diseño #1 del task doc):
 * `fastify.supabaseUser(jwt)` + un SELECT que RLS deniega si el usuario no
 * es miembro — nunca un chequeo manual de `organization_members` con
 * `supabaseAdmin`. La única excepción es la creación de la organización
 * (todavía no hay membresía que proteja nada).
 */
export async function organizationOnboardingRoutes(fastify: FastifyInstance) {
    /**
     * Helper interno: valida params `{ id }`, autentica, y verifica
     * pertenencia. Devuelve `null` y ya envió la respuesta de error si algo
     * falla — el handler debe hacer `return` inmediatamente en ese caso.
     */
    async function authorizeForOrganization(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<{ userId: string; jwt: string; organizationId: string } | null> {
        const paramsResult = organizationIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
            return null;
        }

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const isMember = await requireOrganizationMembership(fastify, auth.jwt, paramsResult.data.id);
        if (!isMember) {
            reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
            return null;
        }

        return { userId: auth.userId, jwt: auth.jwt, organizationId: paramsResult.data.id };
    }

    /**
     * POST /api/organizations
     * Única excepción al patrón de pertenencia: aún no hay membresía que
     * proteger. Solo exige un usuario autenticado; la membresía `owner` se
     * crea como parte de la misma llamada transaccional.
     */
    fastify.post('/api/organizations', async (request, reply) => {
        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;

        const bodyResult = createOrganizationBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: se requiere "name" y "email".' });
        }
        const { name, email, phone_number } = bodyResult.data;

        const { data: org, error } = await fastify.supabaseAdmin.rpc('create_organization_with_owner', {
            p_name: name,
            p_email: email,
            p_phone_number: phone_number ?? null,
            p_user_id: auth.userId,
        });

        if (error || !org) {
            request.log.error({ err: error?.message, msg: 'Error creando organización vía create_organization_with_owner' });
            const statusCode = error?.code === '23505' ? 409 : 500;
            return reply.status(statusCode).send({
                success: false,
                error: statusCode === 409 ? 'Ya existe una organización con ese correo.' : 'No se pudo crear la organización.',
            });
        }

        return reply.status(201).send(
            createOrganizationResponseSchema.parse({
                success: true,
                data: { id: org.id, name: org.name, email: org.email },
            })
        );
    });

    /**
     * PATCH /api/organizations/:id/business-info
     */
    fastify.patch('/api/organizations/:id/business-info', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const bodyResult = businessInfoBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido.' });
        }
        const body = bodyResult.data;

        const updatePayload: Record<string, unknown> = {};
        if (body.name !== undefined) updatePayload.name = body.name;

        if (body.business_hours !== undefined) {
            // integration_settings ya contiene `theme` (escrito por el
            // frontend en fases previas) — merge, nunca reemplazo completo.
            const { data: current } = await fastify.supabaseAdmin
                .from('organizations')
                .select('integration_settings')
                .eq('id', ctx.organizationId)
                .maybeSingle();

            const currentSettings = (current?.integration_settings as Record<string, unknown>) ?? {};
            updatePayload.integration_settings = { ...currentSettings, business_hours: body.business_hours };
        }

        let updatedOrg: Record<string, unknown>;

        if (Object.keys(updatePayload).length > 0) {
            updatePayload.updated_at = new Date().toISOString();

            const { data: updated, error } = await fastify.supabaseAdmin
                .from('organizations')
                .update(updatePayload)
                .eq('id', ctx.organizationId)
                .select()
                .maybeSingle();

            if (error || !updated) {
                request.log.error({ organizationId: ctx.organizationId, err: error?.message, msg: 'Error actualizando business-info' });
                return reply.status(500).send({ success: false, error: 'No se pudo actualizar la información del negocio.' });
            }
            updatedOrg = updated;
        } else {
            const { data: currentOrg } = await fastify.supabaseAdmin
                .from('organizations')
                .select()
                .eq('id', ctx.organizationId)
                .maybeSingle();
            updatedOrg = currentOrg ?? {};
        }

        // Si se enviaron campos de dirección, se persisten en contact_addresses como dirección de la organización (contact_id = null)
        const hasAddressFields =
            body.address !== undefined ||
            body.city !== undefined ||
            body.state !== undefined ||
            body.postal_code !== undefined ||
            body.latitude !== undefined ||
            body.longitude !== undefined;

        if (hasAddressFields) {
            const { data: existingPrimary } = await fastify.supabaseAdmin
                .from('contact_addresses')
                .select('id')
                .eq('organization_id', ctx.organizationId)
                .is('contact_id', null)
                .eq('is_primary', true)
                .is('archived_at', null)
                .maybeSingle();

            if (existingPrimary) {
                const addrUpdate: Record<string, unknown> = {};
                if (body.address !== undefined) addrUpdate.street = body.address;
                if (body.city !== undefined) addrUpdate.city = body.city;
                if (body.state !== undefined) addrUpdate.state = body.state;
                if (body.postal_code !== undefined) addrUpdate.postal_code = body.postal_code;
                if (body.latitude !== undefined) addrUpdate.latitude = body.latitude;
                if (body.longitude !== undefined) addrUpdate.longitude = body.longitude;

                if (Object.keys(addrUpdate).length > 0) {
                    await fastify.supabaseAdmin
                        .from('contact_addresses')
                        .update(addrUpdate)
                        .eq('id', existingPrimary.id);
                }
            } else {
                await fastify.supabaseAdmin
                    .from('contact_addresses')
                    .insert({
                        organization_id: ctx.organizationId,
                        contact_id: null,
                        label: 'Matriz',
                        address_type: 'matriz',
                        is_primary: true,
                        street: body.address ?? 'Domicilio principal',
                        city: body.city ?? null,
                        state: body.state ?? null,
                        postal_code: body.postal_code ?? null,
                        latitude: body.latitude ?? null,
                        longitude: body.longitude ?? null,
                    });
            }
        }

        return reply.status(200).send({ success: true, data: updatedOrg });
    });

    /**
     * PATCH /api/organizations/:id/plan
     */
    fastify.patch('/api/organizations/:id/plan', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const bodyResult = planBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: se requiere "plan_key" y "reason".' });
        }
        const { plan_key, reason } = bodyResult.data;

        const result = await setOrganizationPlan(ctx.organizationId, plan_key, reason, ctx.userId);
        return reply.status(result.success ? 200 : 400).send(result);
    });

    /**
     * POST /api/organizations/:id/credentials
     * El valor de la credencial NUNCA se registra en logs ni se devuelve.
     */
    fastify.post('/api/organizations/:id/credentials', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const bodyResult = credentialsBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: se requiere "provider" y "value".' });
        }
        // Mapeo idéntico al que usa checkProviderCredentials() (services/entitlements.ts).
        const PROVIDER_TO_SECRET_KEY: Record<CredentialProvider, SecretKey> = {
            elevenlabs: SECRET_KEYS.ELEVENLABS_API_KEY,
            telnyx: SECRET_KEYS.TELNYX_API_KEY,
            meta: SECRET_KEYS.WHATSAPP_ACCESS_TOKEN,
            cal: SECRET_KEYS.CAL_API_KEY,
            // Opcional (AGENTS.md, captura de dirección del prospecto): sin
            // ella, services/geocoding.ts simplemente omite la geocodificación
            // — nunca bloquea el resto del onboarding ni ninguna feature.
            google_maps: SECRET_KEYS.GOOGLE_MAPS_KEY,
        };
        const { provider, value } = bodyResult.data;
        const secretKey = PROVIDER_TO_SECRET_KEY[provider];

        const saved = await setSecret(ctx.organizationId, secretKey, value);
        if (!saved) {
            // No se incluye "value" en este log — solo metadatos.
            request.log.error({ organizationId: ctx.organizationId, provider, msg: 'No se pudo guardar la credencial en Vault' });
            return reply.status(500).send({ success: false, error: 'No se pudo guardar la credencial.' });
        }

        return reply.status(200).send({ success: true });
    });

    /**
     * GET /api/organizations/:id/credentials/status
     */
    fastify.get('/api/organizations/:id/credentials/status', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const status = await listSecretStatus(ctx.organizationId);
        return reply.status(200).send(credentialsStatusResponseSchema.parse({ success: true, data: status }));
    });

    /**
     * POST /api/organizations/:id/tokens
     * No sobreescribe tokens ya generados: responde 409 si webhook_token ya
     * tiene valor. Los tres valores generados no vuelven a ser legibles por
     * ningún otro endpoint tras esta respuesta.
     */
    fastify.post('/api/organizations/:id/tokens', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const { data: org, error: readErr } = await fastify.supabaseAdmin
            .from('organizations')
            .select('webhook_token')
            .eq('id', ctx.organizationId)
            .maybeSingle();

        if (readErr || !org) {
            return reply.status(404).send({ success: false, error: 'Organización no encontrada.' });
        }
        if (org.webhook_token) {
            return reply.status(409).send({ success: false, error: 'Los tokens ya fueron generados para esta organización.' });
        }

        const webhookToken = crypto.randomBytes(32).toString('hex');
        const webhookSigningSecret = crypto.randomBytes(32).toString('hex');
        const toolWebhookSecret = crypto.randomBytes(32).toString('hex');

        // `.is('webhook_token', null)` protege contra la carrera de dos
        // llamadas concurrentes: si otra petición ya lo generó entre el
        // SELECT de arriba y este UPDATE, no coincide ninguna fila.
        const { data: updated, error: updateErr } = await fastify.supabaseAdmin
            .from('organizations')
            .update({ webhook_token: webhookToken })
            .eq('id', ctx.organizationId)
            .is('webhook_token', null)
            .select('webhook_token')
            .maybeSingle();

        if (updateErr) {
            request.log.error({ organizationId: ctx.organizationId, err: updateErr.message, msg: 'Error guardando webhook_token' });
            return reply.status(500).send({ success: false, error: 'No se pudo generar el token de webhook.' });
        }
        if (!updated) {
            return reply.status(409).send({ success: false, error: 'Los tokens ya fueron generados para esta organización.' });
        }

        const signSaved = await setSecret(ctx.organizationId, SECRET_KEYS.WEBHOOK_SIGNING_SECRET, webhookSigningSecret);
        const toolSaved = await setSecret(ctx.organizationId, SECRET_KEYS.TOOL_WEBHOOK_SECRET, toolWebhookSecret);

        if (!signSaved || !toolSaved) {
            request.log.error({ organizationId: ctx.organizationId, msg: 'Fallo guardando webhook_signing_secret/tool_webhook_secret en Vault' });
            return reply.status(500).send({ success: false, error: 'No se pudieron guardar los secretos de firma.' });
        }

        return reply.status(201).send(
            tokensResponseSchema.parse({
                success: true,
                data: { webhookToken, webhookSigningSecret, toolWebhookSecret },
            })
        );
    });

    /**
     * POST /api/organizations/:id/provision-agent
     */
    fastify.post('/api/organizations/:id/provision-agent', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const result = await reprovisionAgent(ctx.organizationId);
        return reply.status(200).send(result);
    });

    /**
     * GET /api/organizations/:id/readiness
     */
    fastify.get('/api/organizations/:id/readiness', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const { data: org, error } = await fastify.supabaseAdmin
            .from('organizations')
            .select('plan_key, webhook_token, agent_reprovision_pending')
            .eq('id', ctx.organizationId)
            .maybeSingle();

        if (error || !org) {
            return reply.status(404).send({ success: false, error: 'Organización no encontrada.' });
        }

        const secretStatus = await listSecretStatus(ctx.organizationId);
        const missingTokens: Array<'webhook_token' | 'webhook_signing_secret' | 'tool_webhook_secret'> = [];
        if (!org.webhook_token) missingTokens.push('webhook_token');
        if (!secretStatus[SECRET_KEYS.WEBHOOK_SIGNING_SECRET]?.present) missingTokens.push('webhook_signing_secret');
        if (!secretStatus[SECRET_KEYS.TOOL_WEBHOOK_SECRET]?.present) missingTokens.push('tool_webhook_secret');

        const features = await getOrganizationFeatures(ctx.organizationId);
        const missingCredentials: Array<{ feature: string; provider: string; missingSecret: string }> = [];
        for (const featureKey of features) {
            const check = await checkProviderCredentials(ctx.organizationId, featureKey);
            if (!check.ok) {
                missingCredentials.push({
                    feature: featureKey,
                    provider: check.requiredProvider ?? 'desconocido',
                    missingSecret: check.missingSecret ?? 'desconocido',
                });
            }
        }

        const ready =
            org.plan_key !== null &&
            missingTokens.length === 0 &&
            missingCredentials.length === 0 &&
            !org.agent_reprovision_pending;

        return reply.status(200).send(
            readinessResponseSchema.parse({
                success: true,
                data: {
                    ready,
                    planKey: org.plan_key,
                    missingTokens,
                    missingCredentials,
                    agentReprovisionPending: org.agent_reprovision_pending,
                },
            })
        );
    });
}

export default organizationOnboardingRoutes;
