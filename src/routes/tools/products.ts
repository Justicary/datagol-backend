import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveToolOrganization } from '../../lib/tool-auth.js';
import { withToolTimeout } from '../../lib/tool-timeout.js';
import { isFeatureEnabled } from '../../services/entitlements.js';
import { FEATURE_KEYS } from '../../types/feature-taxonomy.js';
import { stockStatusToSpeech } from '../../types/stock-status.js';
import { toolParamsSchema } from '../../schemas/tool-routes.js';
import { getProductImageSignedUrl } from '../../services/product-image-service.js';
import {
    productsToolBodySchema,
    productsToolResponseSchema,
    MAX_SKUS_PER_REQUEST,
    type ProductResult,
} from '../../schemas/catalog-tool.js';

const DEGRADED_MESSAGE = 'No puedo consultar el precio en este momento, ¿le tomo sus datos y le confirmamos?';
const FEATURE_DISABLED_MESSAGE = 'No tengo el catálogo de productos disponible para consultar en este momento.';

interface ResolveVariantRow {
    sku: string;
    product_name: string;
    presentation: string | null;
    price: number | null;
    currency: string | null;
    price_includes_tax: boolean | null;
    stock_status: string | null;
    stock_note: string | null;
    is_available: boolean | null;
    image_path: string | null;
}

/**
 * POST /tools/:webhookToken/products — FASE D (docs/tasks/catalogo-productos-grupos-cred.md).
 * Recibe uno o varios SKU, resuelve la organización igual que los demás
 * tools, y devuelve precio/disponibilidad VIGENTES vía `resolve_variant_for_org`
 * (migración 56, resuelve override de sucursal > precio de catálogo). Un
 * `SELECT` por índice único: presupuesto p95 < 300 ms (AGENTS.md §3).
 *
 * El precio NUNCA sale de aquí hacia la knowledge base — este es el ÚNICO
 * camino por el que el agente obtiene un precio real. La KB (FASE C) solo
 * indica que este tool existe.
 */
export async function productsToolRoute(fastify: FastifyInstance) {
    fastify.post('/tools/:webhookToken/products', async (request: FastifyRequest, reply: FastifyReply) => {
        const paramsResult = toolParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'webhookToken inválido en la ruta' });
        }

        const secretHeader = request.headers['x-tool-secret'] as string | undefined;
        const auth = await resolveToolOrganization(fastify, paramsResult.data.webhookToken, secretHeader);
        if (!auth.ok) {
            const statusCode = auth.reason === 'suspended' ? 403 : 401;
            request.log.warn({ reason: auth.reason, route: 'products', msg: 'Tool call rechazado' });
            return reply.status(statusCode).send({
                error: statusCode === 403 ? 'Forbidden' : 'Unauthorized',
                message: auth.message,
            });
        }

        const bodyResult = productsToolBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Cuerpo de la petición inválido: se requiere "skus" (arreglo no vacío)' });
        }

        const featureEnabled = await isFeatureEnabled(auth.organizationId, FEATURE_KEYS.PRODUCT_RAG);
        if (!featureEnabled) {
            request.log.info({ organizationId: auth.organizationId, msg: 'Tool de productos llamado sin la feature product_rag habilitada' });
            return reply.status(200).send(productsToolResponseSchema.parse({ results: [], message: FEATURE_DISABLED_MESSAGE }));
        }

        // Dedup + tope (FASE G: "ofrezca máximo dos o tres productos por
        // turno") — se procesa de más sin rechazar, nunca un 400 que el
        // agente no pueda verbalizar.
        const skus = Array.from(new Set(bodyResult.data.skus.map((s) => s.trim()).filter(Boolean))).slice(0, MAX_SKUS_PER_REQUEST);

        try {
            const results = await Promise.all(skus.map((sku) => resolveOneSku(fastify, auth.organizationId, sku)));
            return reply.status(200).send(productsToolResponseSchema.parse({ results }));
        } catch (err) {
            request.log.error(
                { organizationId: auth.organizationId, err: err instanceof Error ? err.message : String(err), msg: 'Tool de productos degradado: error inesperado' },
            );
            return reply.status(200).send(productsToolResponseSchema.parse({ results: [], message: DEGRADED_MESSAGE }));
        }
    });
}

// Firmar la imagen es una llamada de red extra que el presupuesto p95<300ms
// (AGENTS.md §3) no contempló al diseñar este tool — se acota a un tope
// corto y, si no llega a tiempo, se omite `imageUrl` en vez de retrasar el
// precio/disponibilidad, que es lo único que el agente necesita para hablar.
const IMAGE_SIGN_BUDGET_MS = 200;

async function signImageWithBudget(fastify: FastifyInstance, imagePath: string): Promise<string | null> {
    try {
        return await Promise.race([
            getProductImageSignedUrl(fastify, imagePath),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), IMAGE_SIGN_BUDGET_MS)),
        ]);
    } catch {
        return null;
    }
}

async function resolveOneSku(fastify: FastifyInstance, organizationId: string, sku: string): Promise<ProductResult> {
    try {
        const row = await withToolTimeout(async (signal) => {
            const { data, error } = await fastify.supabaseAdmin
                .rpc('resolve_variant_for_org', { p_org_id: organizationId, p_sku: sku })
                .abortSignal(signal)
                .maybeSingle();
            if (error) throw new Error(error.message);
            return (data as ResolveVariantRow | null) ?? null;
        });

        if (!row) {
            return { sku, found: false };
        }

        const isAvailable = row.is_available ?? false;
        const imageUrl = row.image_path ? await signImageWithBudget(fastify, row.image_path) : null;

        return {
            sku: row.sku,
            found: true,
            presentation: row.presentation,
            price: row.price,
            currency: row.currency,
            priceIncludesTax: row.price_includes_tax,
            availabilityText: isAvailable ? stockStatusToSpeech(row.stock_status ?? 'sin_dato') : stockStatusToSpeech('agotado'),
            imageUrl,
        };
    } catch (err) {
        fastify.log.warn(
            { organizationId, sku, err: err instanceof Error ? err.message : String(err), msg: 'No se pudo resolver este SKU, se reporta como no encontrado' },
        );
        return { sku, found: false };
    }
}

export default productsToolRoute;
