import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuthenticatedUser, requireOrganizationMembership, requireOrganizationRole } from '../lib/organization-auth.js';
import { organizationIdParamsSchema } from '../schemas/organization-onboarding.js';
import { competitorSiteBodySchema, competitorSiteUpdateSchema, competitorSiteParamSchema } from '../schemas/competitor-sites.js';
import { MAX_COMPETITOR_SITES_PER_ORG } from '../types/competitor-analysis.js';

/**
 * CRUD de sitios de competencia vigilados (Fase C, docs/tasks/reportes-semanales.md).
 * Calcado del patrón de `routes/organization-widget.ts` (orígenes del
 * widget), salvo que aquí las escrituras exigen rol admin/owner — igual que
 * `reports-config` (Fase B): esta configuración tiene impacto de costo de
 * tokens (cada sitio consume LLM en el resumen semanal), a diferencia de un
 * origen de widget que no lo tiene.
 */
export async function organizationCompetitorSitesRoutes(fastify: FastifyInstance) {
    async function authorizeMember(
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

    async function authorizeAdmin(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<{ userId: string; jwt: string; organizationId: string } | null> {
        const ctx = await authorizeMember(request, reply);
        if (!ctx) return null;

        const isAuthorizedRole = await requireOrganizationRole(fastify, ctx.jwt, ctx.organizationId, ctx.userId, ['owner', 'admin']);
        if (!isAuthorizedRole) {
            reply.status(403).send({ success: false, error: 'Se requiere rol admin u owner para gestionar los sitios de competencia.' });
            return null;
        }

        return ctx;
    }

    /**
     * GET /api/organizations/:id/competitor-sites
     */
    fastify.get('/api/organizations/:id/competitor-sites', async (request, reply) => {
        const ctx = await authorizeMember(request, reply);
        if (!ctx) return;

        const { data, error } = await fastify.supabaseAdmin
            .from('competitor_sites')
            .select('id, url, label, enabled, last_checked_at, last_error, created_at')
            .eq('organization_id', ctx.organizationId)
            .order('created_at', { ascending: true });

        if (error) {
            request.log.error({ organizationId: ctx.organizationId, err: error.message, msg: 'Error listando competitor_sites' });
            return reply.status(500).send({ success: false, error: 'No se pudieron obtener los sitios de competencia.' });
        }

        return reply.status(200).send({ success: true, data: data ?? [] });
    });

    /**
     * POST /api/organizations/:id/competitor-sites
     * Rechaza con 422 si la organización ya tiene 3 sitios (C.1).
     */
    fastify.post('/api/organizations/:id/competitor-sites', async (request, reply) => {
        const ctx = await authorizeAdmin(request, reply);
        if (!ctx) return;

        const bodyResult = competitorSiteBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: se requiere "url" (http(s) válida).' });
        }

        const { count, error: countError } = await fastify.supabaseAdmin
            .from('competitor_sites')
            .select('id', { count: 'exact', head: true })
            .eq('organization_id', ctx.organizationId);

        if (countError) {
            request.log.error({ organizationId: ctx.organizationId, err: countError.message, msg: 'Error contando competitor_sites' });
            return reply.status(500).send({ success: false, error: 'No se pudo verificar el límite de sitios.' });
        }
        if ((count ?? 0) >= MAX_COMPETITOR_SITES_PER_ORG) {
            return reply.status(422).send({ success: false, error: `Ya se alcanzó el máximo de ${MAX_COMPETITOR_SITES_PER_ORG} sitios de competencia por organización.` });
        }

        const { data, error } = await fastify.supabaseAdmin
            .from('competitor_sites')
            .insert({
                organization_id: ctx.organizationId,
                url: bodyResult.data.url,
                label: bodyResult.data.label ?? null,
                enabled: true,
            })
            .select('id, url, label, enabled, last_checked_at, last_error, created_at')
            .single();

        if (error) {
            request.log.error({ organizationId: ctx.organizationId, err: error.message, msg: 'Error creando competitor_site' });
            return reply.status(500).send({ success: false, error: 'No se pudo registrar el sitio de competencia.' });
        }

        return reply.status(201).send({ success: true, data });
    });

    /**
     * PATCH /api/organizations/:id/competitor-sites/:siteId
     */
    fastify.patch('/api/organizations/:id/competitor-sites/:siteId', async (request, reply) => {
        const ctx = await authorizeAdmin(request, reply);
        if (!ctx) return;

        const paramsResult = competitorSiteParamSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro "siteId" debe ser un UUID válido.' });
        }

        const bodyResult = competitorSiteUpdateSchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido.' });
        }

        const updatePayload: Record<string, unknown> = {};
        if (bodyResult.data.enabled !== undefined) updatePayload.enabled = bodyResult.data.enabled;
        if (bodyResult.data.label !== undefined) updatePayload.label = bodyResult.data.label;

        const { data, error } = await fastify.supabaseAdmin
            .from('competitor_sites')
            .update(updatePayload)
            .eq('id', paramsResult.data.siteId)
            .eq('organization_id', ctx.organizationId)
            .select('id, url, label, enabled, last_checked_at, last_error, created_at')
            .maybeSingle();

        if (error || !data) {
            return reply.status(404).send({ success: false, error: 'Sitio de competencia no encontrado para esta organización.' });
        }

        return reply.status(200).send({ success: true, data });
    });

    /**
     * DELETE /api/organizations/:id/competitor-sites/:siteId
     */
    fastify.delete('/api/organizations/:id/competitor-sites/:siteId', async (request, reply) => {
        const ctx = await authorizeAdmin(request, reply);
        if (!ctx) return;

        const paramsResult = competitorSiteParamSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro "siteId" debe ser un UUID válido.' });
        }

        const { data, error } = await fastify.supabaseAdmin
            .from('competitor_sites')
            .delete()
            .eq('id', paramsResult.data.siteId)
            .eq('organization_id', ctx.organizationId)
            .select('id')
            .maybeSingle();

        if (error || !data) {
            return reply.status(404).send({ success: false, error: 'Sitio de competencia no encontrado para esta organización.' });
        }

        return reply.status(200).send({ success: true });
    });
}

export default organizationCompetitorSitesRoutes;
