import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { computeToolLatencyP95Ms } from '../lib/tool-latency-tracker.js';
import { getAndResetErrorCount } from '../lib/error-counter.js';

/**
 * Fase B.2 — Esquema CERRADO del latido. Esta es la garantía legal del
 * diseño (docs/tasks/control-plane-backend-datagol.md, "Dos principios"):
 * ningún dato personal de contactos de clientes puede viajar al plano de
 * control. `.strict()` en cada nivel rechaza cualquier campo fuera de esta
 * lista — incluida cualquier clave con nombre de PII que alguien intente
 * colar en el futuro. No se ensambla el payload como objeto libre en
 * ninguna parte de este archivo.
 */
const heartbeatHealthSchema = z
    .object({
        installedVersion: z.string().min(1),
        databaseOk: z.boolean(),
        queueOk: z.boolean(),
        toolLatencyP95Ms: z.number().nonnegative(),
        errorCount5xx: z.number().int().nonnegative(),
    })
    .strict();

const heartbeatPeriodCountsSchema = z
    .object({
        conversations: z.number().int().nonnegative(),
        appointments: z.number().int().nonnegative(),
        prospects: z.number().int().nonnegative(),
    })
    .strict();

export const licenseHeartbeatPayloadSchema = z
    .object({
        health: heartbeatHealthSchema,
        periodCounts: heartbeatPeriodCountsSchema,
        usageUsdByProvider: z.record(z.string(), z.number().nonnegative()),
        activeFeatures: z.array(z.string()),
        seatsUsed: z.number().int().nonnegative(),
        fingerprint: z.string().nullable(),
    })
    .strict();

export type LicenseHeartbeatPayload = z.infer<typeof licenseHeartbeatPayloadSchema>;

const PACKAGE_VERSION = process.env.npm_package_version || '0.0.0';

async function countRowsSince(fastify: FastifyInstance, table: string, since: Date): Promise<number> {
    const { count, error } = await fastify.supabaseAdmin
        .from(table)
        .select('id', { count: 'exact', head: true })
        .gte('created_at', since.toISOString());

    if (error) {
        fastify.log.warn({ err: error.message, table }, '[LicenseHeartbeat] No se pudo contar filas del periodo');
        return 0;
    }
    return count ?? 0;
}

async function sumUsageUsdByProviderSince(fastify: FastifyInstance, since: Date): Promise<Record<string, number>> {
    const { data, error } = await fastify.supabaseAdmin
        .from('usage_events')
        .select('provider, amount_usd')
        .gte('occurred_at', since.toISOString());

    if (error || !data) {
        fastify.log.warn({ err: error?.message }, '[LicenseHeartbeat] No se pudo agregar el consumo del periodo');
        return {};
    }

    const totals: Record<string, number> = {};
    for (const row of data) {
        const provider = String(row.provider);
        const amount = Number(row.amount_usd ?? 0);
        totals[provider] = (totals[provider] ?? 0) + amount;
    }
    for (const provider of Object.keys(totals)) {
        totals[provider] = Math.round(totals[provider] * 100) / 100;
    }
    return totals;
}

async function checkDatabaseOk(fastify: FastifyInstance): Promise<boolean> {
    try {
        const { error } = await fastify.supabaseAdmin.from('organizations').select('count', { count: 'exact', head: true });
        return !error;
    } catch {
        return false;
    }
}

async function checkQueueOk(fastify: FastifyInstance): Promise<boolean> {
    try {
        await fastify.pgBoss.getQueues();
        return true;
    } catch {
        return false;
    }
}

/**
 * Construye el payload agregado del latido diario para el periodo
 * [since, now). Solo cuenta filas (`head: true`) o suma columnas numéricas
 * — nunca selecciona nombre, teléfono, correo ni transcripción de nadie.
 */
export async function buildLicenseHeartbeatPayload(
    fastify: FastifyInstance,
    since: Date,
    activeFeatures: string[],
    fingerprint: string | null
): Promise<LicenseHeartbeatPayload> {
    const [conversations, appointments, prospects, usageUsdByProvider, databaseOk, queueOk] = await Promise.all([
        countRowsSince(fastify, 'leads', since),
        countRowsSince(fastify, 'appointments', since),
        countRowsSince(fastify, 'leads', since),
        sumUsageUsdByProviderSince(fastify, since),
        checkDatabaseOk(fastify),
        checkQueueOk(fastify),
    ]);

    const { count: seatsUsed } = await fastify.supabaseAdmin
        .from('organization_members')
        .select('id', { count: 'exact', head: true });

    const payload: LicenseHeartbeatPayload = {
        health: {
            installedVersion: PACKAGE_VERSION,
            databaseOk,
            queueOk,
            toolLatencyP95Ms: computeToolLatencyP95Ms(),
            errorCount5xx: getAndResetErrorCount(),
        },
        periodCounts: {
            conversations,
            appointments,
            prospects,
        },
        usageUsdByProvider,
        activeFeatures,
        seatsUsed: seatsUsed ?? 0,
        fingerprint,
    };

    // Se valida el objeto que este propio módulo acaba de construir contra
    // el esquema cerrado — no es teatro: si un campo se agrega arriba sin
    // reflejarlo en `licenseHeartbeatPayloadSchema`, esto revienta en vez de
    // enviarlo silenciosamente.
    return licenseHeartbeatPayloadSchema.parse(payload);
}
