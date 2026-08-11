import { FastifyPluginAsync } from 'fastify';
import { supabaseAdmin } from '../../lib/supabase.js';
import { isPlatformAdmin } from '../../lib/platform-admin.js';

interface PlanUpdateBody {
    name?: string;
    setupFeeMxn?: number;
    monthlyFeeMxn?: number | null;
    maxConcurrentCalls?: number;
    isActive?: boolean;
    targetAudience?: string;
    isPopular?: boolean;
    badge?: string | null;
    setupIncludes?: string[];
    retainerIncludes?: string[];
    ctaText?: string;
    showRetainer?: boolean;
}

interface ExchangeRateBody {
    organizationId?: string;
    tipoCambioUSD?: number;
}

function isNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Gestión administrativa de `plans` — fuente de verdad de nombre, precios
 * MXN, máximo de llamadas concurrentes y copy de marketing (bullets, badge,
 * CTA) que consume GET /api/plans/public (../plans.js) en /pricing y la
 * landing. Sin caché de por medio: un PATCH aquí se refleja en la
 * siguiente petición a esa ruta, sin invalidación manual.
 */
export const adminPlansRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', isPlatformAdmin);

    /**
     * GET /api/admin/plans
     * Catálogo completo (incluye planes inactivos) para la consola de admin.
     */
    fastify.get('/api/admin/plans', async (request, reply) => {
        const { data, error } = await supabaseAdmin.from('plans').select('*').order('sort_order', { ascending: true });

        if (error) {
            return reply.status(500).send({ error: 'InternalServerError', message: error.message });
        }

        return reply.send({
            data: (data ?? []).map((plan) => ({
                key: plan.key,
                name: plan.name,
                setupFeeMxn: Number(plan.setup_fee_mxn),
                monthlyFeeMxn: plan.monthly_fee_mxn === null ? null : Number(plan.monthly_fee_mxn),
                maxConcurrentCalls: plan.max_concurrent_calls,
                isActive: plan.is_active,
                sortOrder: plan.sort_order,
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

    /**
     * PATCH /api/admin/plans/:key
     * Actualización parcial: solo se tocan los campos presentes en el body.
     * `monthlyFeeMxn`/`badge` aceptan `null` explícito ("Iguala A Medida" /
     * sin badge) — distinto de omitir el campo (no tocar el valor actual).
     */
    fastify.patch<{ Params: { key: string }; Body: PlanUpdateBody }>(
        '/api/admin/plans/:key',
        async (request, reply) => {
            const { key } = request.params;
            const body = request.body || {};

            const updatePayload: Record<string, unknown> = {};

            if (body.name !== undefined) {
                if (typeof body.name !== 'string' || body.name.trim() === '') {
                    return reply.status(400).send({ error: 'BadRequest', message: 'El campo "name" no puede estar vacío.' });
                }
                updatePayload.name = body.name.trim();
            }

            if (body.targetAudience !== undefined) {
                if (typeof body.targetAudience !== 'string' || body.targetAudience.trim() === '') {
                    return reply.status(400).send({ error: 'BadRequest', message: 'El campo "targetAudience" no puede estar vacío.' });
                }
                updatePayload.target_audience = body.targetAudience.trim();
            }

            if (body.ctaText !== undefined) {
                if (typeof body.ctaText !== 'string' || body.ctaText.trim() === '') {
                    return reply.status(400).send({ error: 'BadRequest', message: 'El campo "ctaText" no puede estar vacío.' });
                }
                updatePayload.cta_text = body.ctaText.trim();
            }

            if (body.badge !== undefined) {
                if (body.badge !== null && (typeof body.badge !== 'string' || body.badge.trim() === '')) {
                    return reply.status(400).send({ error: 'BadRequest', message: 'El campo "badge" debe ser texto no vacío o null.' });
                }
                updatePayload.badge = body.badge === null ? null : body.badge.trim();
            }

            if (body.setupFeeMxn !== undefined) {
                if (!isNonNegativeNumber(body.setupFeeMxn)) {
                    return reply.status(400).send({ error: 'BadRequest', message: 'El campo "setupFeeMxn" debe ser un número mayor o igual a 0.' });
                }
                updatePayload.setup_fee_mxn = body.setupFeeMxn;
            }

            if (body.monthlyFeeMxn !== undefined) {
                if (body.monthlyFeeMxn !== null && !isNonNegativeNumber(body.monthlyFeeMxn)) {
                    return reply.status(400).send({ error: 'BadRequest', message: 'El campo "monthlyFeeMxn" debe ser un número mayor o igual a 0, o null para "Iguala A Medida".' });
                }
                updatePayload.monthly_fee_mxn = body.monthlyFeeMxn;
            }

            if (body.maxConcurrentCalls !== undefined) {
                if (!isNonNegativeNumber(body.maxConcurrentCalls) || !Number.isInteger(body.maxConcurrentCalls)) {
                    return reply.status(400).send({ error: 'BadRequest', message: 'El campo "maxConcurrentCalls" debe ser un entero mayor o igual a 0.' });
                }
                updatePayload.max_concurrent_calls = body.maxConcurrentCalls;
            }

            for (const [bodyKey, column] of [
                ['setupIncludes', 'setup_includes'],
                ['retainerIncludes', 'retainer_includes'],
            ] as const) {
                const value = body[bodyKey];
                if (value !== undefined) {
                    if (!isStringArray(value)) {
                        return reply.status(400).send({ error: 'BadRequest', message: `El campo "${bodyKey}" debe ser un arreglo de strings.` });
                    }
                    updatePayload[column] = value;
                }
            }

            for (const [bodyKey, column] of [
                ['isActive', 'is_active'],
                ['isPopular', 'is_popular'],
                ['showRetainer', 'show_retainer'],
            ] as const) {
                const value = body[bodyKey];
                if (value !== undefined) {
                    if (typeof value !== 'boolean') {
                        return reply.status(400).send({ error: 'BadRequest', message: `El campo "${bodyKey}" debe ser booleano.` });
                    }
                    updatePayload[column] = value;
                }
            }

            if (Object.keys(updatePayload).length === 0) {
                return reply.status(400).send({ error: 'BadRequest', message: 'No se envió ningún campo para actualizar.' });
            }

            const { data, error } = await supabaseAdmin
                .from('plans')
                .update(updatePayload)
                .eq('key', key)
                .select('key')
                .maybeSingle();

            if (error) {
                return reply.status(500).send({ error: 'InternalServerError', message: error.message });
            }
            if (!data) {
                return reply.status(404).send({ error: 'NotFound', message: `El plan '${key}' no existe.` });
            }

            return reply.status(200).send({ message: `Plan '${key}' actualizado con éxito.` });
        }
    );

    /**
     * GET /api/admin/exchange-rate?organizationId=
     * PATCH /api/admin/exchange-rate
     * Tipo de cambio USD/MXN que /pricing usa para calcular el precio en
     * dólares de cada plan a partir de su precio MXN real — vive en
     * organizations.integration_settings.tipoCambioUSD (mismo campo JSON
     * que ya usa integration_settings.theme, ver PATCH /api/theme del
     * frontend), no en una columna nueva de `plans`.
     */
    fastify.get<{ Querystring: { organizationId?: string } }>('/api/admin/exchange-rate', async (request, reply) => {
        const { organizationId } = request.query;
        if (!organizationId) {
            return reply.status(400).send({ error: 'BadRequest', message: 'El parámetro "organizationId" es obligatorio.' });
        }

        const { data: org, error } = await supabaseAdmin
            .from('organizations')
            .select('integration_settings')
            .eq('id', organizationId)
            .maybeSingle();

        if (error || !org) {
            return reply.status(404).send({ error: 'NotFound', message: 'Organización no encontrada.' });
        }

        const rate = (org.integration_settings as Record<string, unknown> | null)?.tipoCambioUSD;
        return reply.send({ tipoCambioUSD: typeof rate === 'number' ? rate : null });
    });

    fastify.patch<{ Body: ExchangeRateBody }>('/api/admin/exchange-rate', async (request, reply) => {
        const { organizationId, tipoCambioUSD } = request.body || {};

        if (!organizationId) {
            return reply.status(400).send({ error: 'BadRequest', message: 'El campo "organizationId" es obligatorio.' });
        }
        if (!isNonNegativeNumber(tipoCambioUSD) || tipoCambioUSD === 0) {
            return reply.status(400).send({ error: 'BadRequest', message: 'El campo "tipoCambioUSD" debe ser un número mayor a 0.' });
        }

        const { data: org, error: readError } = await supabaseAdmin
            .from('organizations')
            .select('integration_settings')
            .eq('id', organizationId)
            .maybeSingle();

        if (readError || !org) {
            return reply.status(404).send({ error: 'NotFound', message: 'Organización no encontrada.' });
        }

        const nextSettings = {
            ...((org.integration_settings as Record<string, unknown> | null) ?? {}),
            tipoCambioUSD,
        };

        const { error: updateError } = await supabaseAdmin
            .from('organizations')
            .update({ integration_settings: nextSettings })
            .eq('id', organizationId);

        if (updateError) {
            return reply.status(500).send({ error: 'InternalServerError', message: updateError.message });
        }

        return reply.status(200).send({ message: 'Tipo de cambio USD actualizado con éxito.' });
    });
};

export default adminPlansRoutes;
