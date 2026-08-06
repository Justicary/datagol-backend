import { FastifyInstance } from 'fastify';

export interface ReconciliationLineItem {
    provider: string;
    unitType: string;
    unitRateUsd: number;
    quantity: number;
    amountUsd: number;
    entriesCount: number;
}

export interface ReconciliationProviderTotal {
    provider: string;
    quantity: number;
    amountUsd: number;
}

export interface ReconciliationReport {
    organizationId: string;
    periodFrom: string;
    periodTo: string;
    lineItems: ReconciliationLineItem[];
    totalsByProvider: ReconciliationProviderTotal[];
    totalAmountUsd: number;
}

interface UsageEventRow {
    provider: string;
    unit_type: string;
    unit_rate_usd: string | number;
    quantity: string | number;
    amount_usd: string | number | null;
}

/**
 * Fase 3.3 — Conciliación. Agrega el metering interno (`usage_events`) de una
 * organización en un periodo dado, agrupado por `(provider, unit_type,
 * unit_rate_usd)` — se mantiene la tarifa como parte de la clave de
 * agrupación porque puede haber cambiado dentro del mismo periodo (§3.1), y
 * mezclar tarifas distintas en una sola fila ocultaría exactamente el tipo de
 * discrepancia que este endpoint existe para detectar.
 *
 * No compara contra la factura real del proveedor (eso vive fuera de este
 * sistema) — produce el lado "interno" de la comparación para que un
 * administrador la coteje manualmente contra la factura descargada del
 * proveedor.
 */
export async function getUsageReconciliation(
    fastify: FastifyInstance,
    organizationId: string,
    periodFrom: Date,
    periodTo: Date
): Promise<ReconciliationReport> {
    const { data, error } = await fastify.supabaseAdmin
        .from('usage_events')
        .select('provider, unit_type, unit_rate_usd, quantity, amount_usd')
        .eq('organization_id', organizationId)
        .gte('occurred_at', periodFrom.toISOString())
        .lt('occurred_at', periodTo.toISOString());

    if (error) {
        throw new Error(`No se pudo consultar usage_events para la conciliación: ${error.message}`);
    }

    const rows = (data as UsageEventRow[] | null) ?? [];

    const lineItemMap = new Map<string, ReconciliationLineItem>();
    for (const row of rows) {
        const unitRateUsd = Number(row.unit_rate_usd);
        const key = `${row.provider}:${row.unit_type}:${unitRateUsd}`;
        const existing = lineItemMap.get(key);
        const quantity = Number(row.quantity);
        const amountUsd = row.amount_usd !== null ? Number(row.amount_usd) : quantity * unitRateUsd;

        if (existing) {
            existing.quantity += quantity;
            existing.amountUsd += amountUsd;
            existing.entriesCount += 1;
        } else {
            lineItemMap.set(key, {
                provider: row.provider,
                unitType: row.unit_type,
                unitRateUsd,
                quantity,
                amountUsd,
                entriesCount: 1,
            });
        }
    }

    const lineItems = Array.from(lineItemMap.values()).sort((a, b) =>
        a.provider === b.provider ? a.unitType.localeCompare(b.unitType) : a.provider.localeCompare(b.provider)
    );

    const providerTotalsMap = new Map<string, ReconciliationProviderTotal>();
    for (const item of lineItems) {
        const existing = providerTotalsMap.get(item.provider);
        if (existing) {
            existing.quantity += item.quantity;
            existing.amountUsd += item.amountUsd;
        } else {
            providerTotalsMap.set(item.provider, {
                provider: item.provider,
                quantity: item.quantity,
                amountUsd: item.amountUsd,
            });
        }
    }

    const totalsByProvider = Array.from(providerTotalsMap.values()).sort((a, b) => a.provider.localeCompare(b.provider));
    const totalAmountUsd = totalsByProvider.reduce((sum, t) => sum + t.amountUsd, 0);

    return {
        organizationId,
        periodFrom: periodFrom.toISOString(),
        periodTo: periodTo.toISOString(),
        lineItems,
        totalsByProvider,
        totalAmountUsd,
    };
}
