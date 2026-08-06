import { FastifyInstance } from 'fastify';

export interface ProviderRate {
    id: string;
    provider: string;
    unitType: string;
    unitRateUsd: number;
    effectiveFrom: Date;
    effectiveTo: Date | null;
}

interface ProviderRateRow {
    id: string;
    provider: string;
    unit_type: string;
    unit_rate_usd: string | number;
    effective_from: string;
    effective_to: string | null;
}

// Tabla pequeña de lectura muy frecuente (AGENTS.md §3.1): se cachea completa
// en memoria en vez de una consulta por resolución de tarifa.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

let cachedRates: ProviderRate[] | null = null;
let cachedAt = 0;

async function loadRates(fastify: FastifyInstance): Promise<ProviderRate[]> {
    const now = Date.now();
    if (cachedRates && now - cachedAt < CACHE_TTL_MS) {
        return cachedRates;
    }

    // provider_rates tiene RLS activo y sin políticas (ver CONSIDERACIONES
    // TÉCNICAS ADICIONALES §1 de backend-implementation.md): solo se puede
    // leer con service_role, nunca con el cliente de usuario.
    const { data, error } = await fastify.supabaseAdmin
        .from('provider_rates')
        .select('id, provider, unit_type, unit_rate_usd, effective_from, effective_to');

    if (error) {
        throw new Error(`No se pudo cargar el tarifario de provider_rates: ${error.message}`);
    }

    cachedRates = ((data as ProviderRateRow[] | null) ?? []).map((row) => ({
        id: row.id,
        provider: row.provider,
        unitType: row.unit_type,
        unitRateUsd: Number(row.unit_rate_usd),
        effectiveFrom: new Date(row.effective_from),
        effectiveTo: row.effective_to ? new Date(row.effective_to) : null,
    }));
    cachedAt = now;
    return cachedRates;
}

/**
 * Resuelve la tarifa vigente para `provider`/`unitType` en el instante
 * `occurredAt` (el momento real del consumo, nunca el momento de procesar el
 * webhook). Busca el registro cuyo `effective_from` sea el más reciente
 * anterior o igual a `occurredAt`, con `effective_to` nulo o posterior.
 *
 * Nunca usa la tarifa actual para un consumo pasado (AGENTS.md §3.1 y §6):
 * los proveedores cambian precios cada trimestre y recalcular con la tarifa
 * vigente produce cifras falsas. Devuelve `null` si ninguna tarifa cubre esa
 * fecha — el llamador decide degradar (omitir el asiento), nunca inventa una
 * tarifa para poder insertar de todos modos.
 */
export async function getRate(
    fastify: FastifyInstance,
    provider: string,
    unitType: string,
    occurredAt: Date
): Promise<ProviderRate | null> {
    const rates = await loadRates(fastify);

    const candidates = rates.filter(
        (rate) =>
            rate.provider === provider &&
            rate.unitType === unitType &&
            rate.effectiveFrom <= occurredAt &&
            (rate.effectiveTo === null || rate.effectiveTo > occurredAt)
    );

    if (candidates.length === 0) {
        return null;
    }

    candidates.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
    return candidates[0];
}

/**
 * Invalida la caché en memoria del tarifario. Se expone para pruebas y para
 * un eventual endpoint administrativo que edite `provider_rates`.
 */
export function invalidateRateCache(): void {
    cachedRates = null;
    cachedAt = 0;
}
