import { FastifyPluginAsync } from 'fastify';
import { supabaseAdmin } from '../lib/supabase.js';

interface PublicPlansQuery {
    organizationId?: string;
}

/**
 * Catálogo público de planes — consumido por datagol-frontend en `/` y
 * `/pricing` (Server Components, sin caché) para que el precio y la copy de
 * marketing mostrados sean siempre los reales de `plans`, nunca un literal
 * desactualizado en el frontend. `/pricing` es además la URL que se vincula
 * como fuente de Knowledge Base (RAG) del agente de ElevenLabs — este
 * endpoint es la razón por la que esa página siempre puede mostrar el
 * contenido vigente sin redeploy.
 *
 * Sin autenticación a propósito (visitante anónimo de la landing). Usa
 * `supabaseAdmin` para no depender de la RLS `catalog_read` (restringida a
 * `authenticated`, pensada para el onboarding ya logueado) — whitelist
 * explícita de columnas, mismo criterio que
 * GET /api/organizations/:id/public-profile.
 *
 * `tipoCambioUsd` viaja en la misma respuesta (no hay setup_fee_usd/
 * monthly_fee_usd en `plans` a propósito): el precio USD de cada plan se
 * calcula en el frontend a partir del MXN real y este tipo de cambio, que
 * el admin declara en organizations.integration_settings.tipoCambioUSD
 * (?organizationId=, mismo query param que ya usa GET /api/theme).
 */
export const plansRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get<{ Querystring: PublicPlansQuery }>('/api/plans/public', async (request, reply) => {
        const { data, error } = await supabaseAdmin
            .from('plans')
            .select(
                'key, name, setup_fee_mxn, monthly_fee_mxn, max_concurrent_calls, target_audience, is_popular, badge, setup_includes, retainer_includes, cta_text, show_retainer'
            )
            .eq('is_active', true)
            .order('sort_order', { ascending: true });

        if (error) {
            request.log.error({ err: error, msg: 'Error consultando catálogo público de planes' });
            return reply.status(500).send({ success: false, error: 'No se pudo consultar el catálogo de planes.' });
        }

        let tipoCambioUsd: number | null = null;
        const { organizationId } = request.query;
        if (organizationId) {
            const { data: org } = await supabaseAdmin
                .from('organizations')
                .select('integration_settings')
                .eq('id', organizationId)
                .maybeSingle();

            const rawRate = (org?.integration_settings as Record<string, unknown> | null)?.tipoCambioUSD;
            if (typeof rawRate === 'number' && Number.isFinite(rawRate) && rawRate > 0) {
                tipoCambioUsd = rawRate;
            }
        }

        return reply.send({
            success: true,
            tipoCambioUsd,
            data: (data ?? []).map((plan) => ({
                key: plan.key,
                name: plan.name,
                setupFeeMxn: Number(plan.setup_fee_mxn),
                monthlyFeeMxn: plan.monthly_fee_mxn === null ? null : Number(plan.monthly_fee_mxn),
                maxConcurrentCalls: plan.max_concurrent_calls,
                targetAudience: plan.target_audience,
                isPopular: plan.is_popular,
                badge: plan.badge,
                setupIncludes: plan.setup_includes ?? [],
                retainerIncludes: plan.retainer_includes ?? [],
                ctaText: plan.cta_text,
                showRetainer: plan.show_retainer,
            })),
        });
    });
};

export default plansRoutes;
