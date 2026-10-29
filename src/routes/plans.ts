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
                'key, name, setup_fee_mxn, monthly_fee_mxn, max_concurrent_calls, target_audience, is_popular, badge, setup_includes, retainer_includes, cta_text, show_retainer, annual_retainer_discount_pct'
            )
            .eq('is_active', true)
            .order('sort_order', { ascending: true });

        if (error) {
            request.log.error({ err: error, msg: 'Error consultando catálogo público de planes' });
            return reply.status(500).send({ success: false, error: 'No se pudo consultar el catálogo de planes.' });
        }

        const { data: managedCatalog } = await supabaseAdmin
            .from('catalogs')
            .select('id')
            .eq('managed_source', 'datagol_plans')
            .maybeSingle();

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
            data: (data ?? []).map((plan) => {
                const keyUpper = String(plan.key).toUpperCase();
                return {
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
                    annualDiscountPct: Number(plan.annual_retainer_discount_pct ?? 0.2),
                    catalogRefs: managedCatalog
                        ? {
                              setupSku: `PLAN-${keyUpper}`,
                              monthlySku: `MANT-${keyUpper}-MENSUAL`,
                              annualSku: `MANT-${keyUpper}-ANUAL`,
                          }
                        : null,
                };
            }),
        });
    });

    /**
     * GET /api/plans/public/addons?organizationId=
     * Add-ons comercializados como servicios (`item_type = 'servicio'`,
     * `category = 'addon'`) en los catálogos NO administrados
     * (`managed_source is null`, H20/H21) de la organización indicada.
     */
    fastify.get<{ Querystring: PublicPlansQuery }>('/api/plans/public/addons', async (request, reply) => {
        const { organizationId } = request.query;
        if (!organizationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {
            return reply.status(400).send({
                success: false,
                error: 'El parámetro "organizationId" es obligatorio y debe ser un UUID válido.',
            });
        }

        const { data: org } = await supabaseAdmin
            .from('organizations')
            .select('integration_settings')
            .eq('id', organizationId)
            .maybeSingle();

        let tipoCambioUsd: number | null = null;
        const rawRate = (org?.integration_settings as Record<string, unknown> | null)?.tipoCambioUSD;
        if (typeof rawRate === 'number' && Number.isFinite(rawRate) && rawRate > 0) {
            tipoCambioUsd = rawRate;
        }

        const { data: accessRows, error: accessErr } = await supabaseAdmin
            .from('catalog_access')
            .select('catalog_id, catalogs!inner(id, managed_source)')
            .eq('organization_id', organizationId)
            .is('catalogs.managed_source', null);

        if (accessErr) {
            request.log.error({ err: accessErr, organizationId, msg: 'Error consultando catálogos de add-ons' });
            return reply.status(500).send({ success: false, error: 'No se pudieron consultar los add-ons.' });
        }

        const catalogIds = (accessRows ?? []).map((r) => r.catalog_id as string);
        if (catalogIds.length === 0) {
            return reply.send({ success: true, tipoCambioUsd, data: [] });
        }

        const { data: products, error: prodErr } = await supabaseAdmin
            .from('products')
            .select('id, name, description, suggested_use, item_type, category')
            .in('catalog_id', catalogIds)
            .eq('item_type', 'servicio')
            .eq('category', 'addon')
            .eq('is_active', true)
            .order('name', { ascending: true });

        if (prodErr) {
            request.log.error({ err: prodErr, organizationId, msg: 'Error consultando productos add-on' });
            return reply.status(500).send({ success: false, error: 'No se pudieron consultar los add-ons.' });
        }

        const productIds = (products ?? []).map((p) => p.id as string);
        const { data: variants, error: varErr } =
            productIds.length > 0
                ? await supabaseAdmin
                      .from('product_variants')
                      .select('product_id, sku, presentation, price, currency, price_includes_tax, billing_period')
                      .in('product_id', productIds)
                      .eq('is_active', true)
                      .order('sku', { ascending: true })
                : { data: [], error: null };

        if (varErr) {
            request.log.error({ err: varErr, organizationId, msg: 'Error consultando variantes de add-on' });
            return reply.status(500).send({ success: false, error: 'No se pudieron consultar las variantes de add-ons.' });
        }

        const variantsByProduct = new Map<
            string,
            Array<{
                sku: string;
                presentation: string | null;
                price: number | null;
                currency: string;
                priceIncludesTax: boolean;
                billingPeriod: string;
            }>
        >();

        for (const v of variants ?? []) {
            const list = variantsByProduct.get(v.product_id as string) ?? [];
            list.push({
                sku: v.sku as string,
                presentation: (v.presentation as string | null) ?? null,
                price: v.price === null ? null : Number(v.price),
                currency: (v.currency as string) ?? 'MXN',
                priceIncludesTax: Boolean(v.price_includes_tax),
                billingPeriod: (v.billing_period as string) ?? 'unico',
            });
            variantsByProduct.set(v.product_id as string, list);
        }

        return reply.send({
            success: true,
            tipoCambioUsd,
            data: (products ?? []).map((p) => ({
                id: p.id,
                name: p.name,
                description: p.description ?? null,
                suggestedUse: p.suggested_use ?? null,
                variants: variantsByProduct.get(p.id as string) ?? [],
            })),
        });
    });
};

export default plansRoutes;
