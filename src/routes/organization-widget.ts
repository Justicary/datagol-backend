import crypto from 'crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuthenticatedUser, requireOrganizationMembership } from '../lib/organization-auth.js';
import { normalizeOrigin, clearOriginRegistryCache } from '../lib/widget-auth.js';
import {
    organizationIdParamsSchema,
    widgetOriginParamsSchema,
    createWidgetOriginBodySchema,
    updateWidgetOriginBodySchema,
    listWidgetOriginsResponseSchema,
    widgetOriginResponseSchema,
    updateWidgetSettingsBodySchema,
    widgetSettingsResponseSchema,
} from '../schemas/widget-origins.js';

function generatePublicKey(): string {
    return `pk_${crypto.randomBytes(24).toString('hex')}`;
}

interface WidgetOriginRow {
    id: string;
    origin: string;
    public_key: string;
    enabled: boolean;
    created_at: string;
}

function toWidgetOriginDTO(row: WidgetOriginRow) {
    return {
        id: row.id,
        origin: row.origin,
        publicKey: row.public_key,
        enabled: row.enabled,
        createdAt: row.created_at,
    };
}

/**
 * Gestión, desde el dashboard del tenant, de los orígenes autorizados a usar
 * su widget de chat web (POST /api/widget/session, routes/widget.ts) y del
 * tope diario de sesiones. Mismo patrón de autenticación/pertenencia que
 * routes/organization-onboarding.ts: `fastify.supabaseUser(jwt)` + RLS
 * decide la pertenencia, las escrituras van por `supabaseAdmin` ya
 * autorizadas y siempre filtradas por `organization_id` explícito (nunca
 * confiar en un id de organización que venga del body).
 */
export async function organizationWidgetRoutes(fastify: FastifyInstance) {
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
     * GET /api/organizations/:id/widget-origins
     */
    fastify.get('/api/organizations/:id/widget-origins', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const { data, error } = await fastify.supabaseAdmin
            .from('widget_origins')
            .select('id, origin, public_key, enabled, created_at')
            .eq('organization_id', ctx.organizationId)
            .order('created_at', { ascending: true });

        if (error) {
            request.log.error({ organizationId: ctx.organizationId, err: error.message, msg: 'Error listando widget_origins' });
            return reply.status(500).send({ success: false, error: 'No se pudieron obtener los orígenes del widget.' });
        }

        return reply
            .status(200)
            .send(listWidgetOriginsResponseSchema.parse({ success: true, data: (data || []).map(toWidgetOriginDTO) }));
    });

    /**
     * POST /api/organizations/:id/widget-origins
     */
    fastify.post('/api/organizations/:id/widget-origins', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const bodyResult = createWidgetOriginBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: se requiere "origin" (URL válida).' });
        }

        const normalized = normalizeOrigin(bodyResult.data.origin);
        if (!normalized) {
            return reply.status(400).send({ success: false, error: 'El origen debe ser una URL http(s) válida, ej. https://cliente.com.' });
        }

        const { data, error } = await fastify.supabaseAdmin
            .from('widget_origins')
            .insert({
                organization_id: ctx.organizationId,
                origin: normalized,
                public_key: generatePublicKey(),
                enabled: true,
            })
            .select('id, origin, public_key, enabled, created_at')
            .single();

        if (error) {
            if (error.code === '23505') {
                return reply.status(409).send({ success: false, error: 'Este origen ya está registrado para esta organización.' });
            }
            request.log.error({ organizationId: ctx.organizationId, err: error.message, msg: 'Error creando widget_origin' });
            return reply.status(500).send({ success: false, error: 'No se pudo registrar el origen.' });
        }

        clearOriginRegistryCache();
        return reply.status(201).send(widgetOriginResponseSchema.parse({ success: true, data: toWidgetOriginDTO(data) }));
    });

    /**
     * PATCH /api/organizations/:id/widget-origins/:originId
     */
    fastify.patch('/api/organizations/:id/widget-origins/:originId', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const paramsResult = widgetOriginParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro "originId" debe ser un UUID válido.' });
        }

        const bodyResult = updateWidgetOriginBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'El campo "enabled" (boolean) es obligatorio.' });
        }

        const { data, error } = await fastify.supabaseAdmin
            .from('widget_origins')
            .update({ enabled: bodyResult.data.enabled })
            .eq('id', paramsResult.data.originId)
            .eq('organization_id', ctx.organizationId)
            .select('id, origin, public_key, enabled, created_at')
            .maybeSingle();

        if (error || !data) {
            return reply.status(404).send({ success: false, error: 'Origen no encontrado para esta organización.' });
        }

        clearOriginRegistryCache();
        return reply.status(200).send(widgetOriginResponseSchema.parse({ success: true, data: toWidgetOriginDTO(data) }));
    });

    /**
     * DELETE /api/organizations/:id/widget-origins/:originId
     */
    fastify.delete('/api/organizations/:id/widget-origins/:originId', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const paramsResult = widgetOriginParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro "originId" debe ser un UUID válido.' });
        }

        const { data, error } = await fastify.supabaseAdmin
            .from('widget_origins')
            .delete()
            .eq('id', paramsResult.data.originId)
            .eq('organization_id', ctx.organizationId)
            .select('id')
            .maybeSingle();

        if (error || !data) {
            return reply.status(404).send({ success: false, error: 'Origen no encontrado para esta organización.' });
        }

        clearOriginRegistryCache();
        return reply.status(200).send({ success: true });
    });

    /**
     * GET /api/organizations/:id/widget-settings
     */
    fastify.get('/api/organizations/:id/widget-settings', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const { data, error } = await fastify.supabaseAdmin
            .from('organizations')
            .select('widget_daily_session_limit')
            .eq('id', ctx.organizationId)
            .maybeSingle();

        if (error || !data) {
            return reply.status(404).send({ success: false, error: 'Organización no encontrada.' });
        }

        return reply
            .status(200)
            .send(widgetSettingsResponseSchema.parse({ success: true, data: { dailySessionLimit: data.widget_daily_session_limit } }));
    });

    /**
     * PATCH /api/organizations/:id/widget-settings
     */
    fastify.patch('/api/organizations/:id/widget-settings', async (request, reply) => {
        const ctx = await authorizeForOrganization(request, reply);
        if (!ctx) return;

        const bodyResult = updateWidgetSettingsBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'El campo "dailySessionLimit" debe ser un entero positivo.' });
        }

        const { data, error } = await fastify.supabaseAdmin
            .from('organizations')
            .update({ widget_daily_session_limit: bodyResult.data.dailySessionLimit, updated_at: new Date().toISOString() })
            .eq('id', ctx.organizationId)
            .select('widget_daily_session_limit')
            .maybeSingle();

        if (error || !data) {
            return reply.status(500).send({ success: false, error: 'No se pudo actualizar el límite diario del widget.' });
        }

        return reply
            .status(200)
            .send(widgetSettingsResponseSchema.parse({ success: true, data: { dailySessionLimit: data.widget_daily_session_limit } }));
    });
}

export default organizationWidgetRoutes;
