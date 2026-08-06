import { describe, it, expect, beforeAll } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import adminMeteringRoutes from '../src/routes/admin/metering.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

// usage_events es append-only (no admite UPDATE/DELETE) y sus filas ya
// escritas no se pueden neutralizar sin dejar rastro en `quantity` (el CHECK
// constraint exige quantity >= 0 — una corrección solo puede negar
// `unit_rate_usd`, nunca la cantidad consumida). Por eso, igual que
// __tests__/usage-event-provider.test.ts, este test usa un `unit_type`
// diagnóstico único por ejecución (sufijo de tiempo) en vez de los
// unit_type reales ('agent_minute', 'sip_inbound_local_mx'): así cada
// corrida queda perfectamente aislada de las anteriores, sin necesidad de
// "limpiar" filas permanentes ni de tolerar acumulación entre corridas.
const RUN_ID = Date.now();
const DIAG_AGENT_UNIT = `diag_recon_agent_minute_${RUN_ID}`;
const DIAG_TELNYX_UNIT = `diag_recon_sip_inbound_${RUN_ID}`;
const CONVERSATION_ID = `reconciliation-test-conv:${RUN_ID}`;
const PERIOD_FROM = '2026-07-01T00:00:00.000Z';
const PERIOD_TO = '2026-07-02T00:00:00.000Z';
const OCCURRED_AT_IN_PERIOD = '2026-07-01T12:00:00.000Z';
const OCCURRED_AT_OUTSIDE_PERIOD = '2026-01-01T00:00:00.000Z';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(adminMeteringRoutes);
    await app.ready();
    return app;
}

describe('3.3 — GET /api/admin/metering/organization/:orgId/reconciliation', () => {
    beforeAll(async () => {
        const { error } = await supabaseAdmin.from('usage_events').insert([
            {
                organization_id: REAL_ORG_ID,
                provider: 'elevenlabs',
                unit_type: DIAG_AGENT_UNIT,
                quantity: 3,
                unit_rate_usd: 0.08,
                conversation_id: CONVERSATION_ID,
                occurred_at: OCCURRED_AT_IN_PERIOD,
                metadata: { diagnostic: 'admin-metering-reconciliation.test.ts' },
            },
            {
                organization_id: REAL_ORG_ID,
                provider: 'telnyx',
                unit_type: DIAG_TELNYX_UNIT,
                quantity: 3,
                unit_rate_usd: 0.005,
                conversation_id: CONVERSATION_ID,
                occurred_at: OCCURRED_AT_IN_PERIOD,
                metadata: { diagnostic: 'admin-metering-reconciliation.test.ts' },
            },
            // Fuera del periodo: no debe aparecer en el reporte.
            {
                organization_id: REAL_ORG_ID,
                provider: 'elevenlabs',
                unit_type: DIAG_AGENT_UNIT,
                quantity: 99,
                unit_rate_usd: 0.08,
                conversation_id: `${CONVERSATION_ID}-fuera-de-periodo`,
                occurred_at: OCCURRED_AT_OUTSIDE_PERIOD,
                metadata: { diagnostic: 'admin-metering-reconciliation.test.ts' },
            },
        ]);

        if (error) {
            throw new Error(`No se pudo sembrar usage_events de prueba: ${error.message}`);
        }
    });

    it('rechaza sin autenticación de plataforma (contraparte de éxito abajo)', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/api/admin/metering/organization/${REAL_ORG_ID}/reconciliation?from=${PERIOD_FROM}&to=${PERIOD_TO}`,
            });
            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('400 cuando faltan los parámetros from/to', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/api/admin/metering/organization/${REAL_ORG_ID}/reconciliation`,
                headers: { 'x-platform-admin': 'true' },
            });
            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it('contraparte de éxito: agrega el consumo del periodo por provider/unit_type y excluye lo fuera de rango', async () => {
        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/api/admin/metering/organization/${REAL_ORG_ID}/reconciliation?from=${PERIOD_FROM}&to=${PERIOD_TO}`,
                headers: { 'x-platform-admin': 'true' },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();

            const agentItem = body.lineItems.find((i: any) => i.unitType === DIAG_AGENT_UNIT);
            expect(agentItem).toBeTruthy();
            expect(agentItem.provider).toBe('elevenlabs');
            expect(agentItem.quantity).toBeCloseTo(3, 5);
            expect(agentItem.amountUsd).toBeCloseTo(0.24, 5);
            expect(agentItem.entriesCount).toBe(1);

            const telnyxItem = body.lineItems.find((i: any) => i.unitType === DIAG_TELNYX_UNIT);
            expect(telnyxItem.provider).toBe('telnyx');
            expect(telnyxItem.quantity).toBeCloseTo(3, 5);
            expect(telnyxItem.amountUsd).toBeCloseTo(0.015, 5);

            // La fila fuera de rango (quantity=99, mismo unit_type) no contamina el total del periodo.
            expect(agentItem.quantity).toBeLessThan(50);

            const elevenlabsTotal = body.totalsByProvider.find((t: any) => t.provider === 'elevenlabs');
            expect(elevenlabsTotal.amountUsd).toBeGreaterThanOrEqual(agentItem.amountUsd);
        } finally {
            await app.close();
        }
    });
});
