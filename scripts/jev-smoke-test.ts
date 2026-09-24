import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { getRate } from '../src/services/rate-service.js';
import { getJevConfig, updateJevConfig, validateJevCredentials } from '../src/services/jev-config-service.js';
import { evaluateJevDecision } from '../src/services/jev-decision-service.js';
import type { JevQuestions } from '../src/services/jev/jev-decisions-client.js';
import { JEV_MODEL_SLUG_PATTERN } from '../src/schemas/jev.js';
import { USAGE_EVENT_PROVIDERS } from '../src/types/usage-event-provider.js';
import { JEV_USAGE_UNIT_TYPES } from '../src/types/usage-event-unit-type.js';

/**
 * Prueba de humo de Jev (TypeSafe AI) contra OpenRouter y la base real
 * (docs/jev-typesafe-manual.md). Confirma de punta a punta, con la llave
 * `jev_api_key` ya guardada en Vault para la organización:
 *
 *   1. Tarifas de `provider_rates` para 'jev' (migración 73).
 *   2. Modelo en `integration_settings.jev` (lo guarda si falta o si se pasa --model).
 *   3. Validación de la llave (GET /api/v1/key, sin consumir tokens).
 *   4. Una decisión real (POST /api/alpha/decisions) con el ejemplo de la
 *      documentación de OpenRouter: una pregunta noul, una choice y una score.
 *   5. Los asientos de consumo en `usage_events` de esa decisión.
 *
 * ⚠️ El paso 4 consume tokens reales de la cuenta de OpenRouter (centavos) y
 * el paso 5 deja dos filas en `usage_events` (append-only, tarifa 0 por
 * BYOK). Es el efecto esperado: así se verifica el metering.
 *
 * Se ejecuta desde Node, nunca desde el editor SQL de Supabase:
 *   pnpm tsx scripts/jev-smoke-test.ts --org <organization_id> [--model ~typesafe/jev-latest]
 *
 * Termina con código 1 en cuanto un paso falla.
 */

const DEFAULT_MODEL = '~typesafe/jev-latest';

const QUESTIONS = {
    is_urgent: {
        type: 'noul',
        instructions: 'Does this message convey urgency?',
        criteria: { true: 'Explicitly time-sensitive', false: 'No urgency expressed' },
    },
    department: {
        type: 'choice',
        instructions: 'Which team should handle this?',
        criteria: {
            billing: 'Payments, invoicing, refunds',
            technical: 'Bugs, outages, integrations',
            sales: 'Pricing, upgrades, new accounts',
        },
    },
    frustration: {
        type: 'score',
        instructions: 'How frustrated is the customer?',
        criteria: ['Calm', 'Frustrated', 'Very angry'],
    },
} as const satisfies JevQuestions;

const STATE = 'Help! My payouts have been failing for 3 days.';

interface ParsedArgs {
    org?: string;
    model?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
    const parsed: ParsedArgs = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--org') parsed.org = argv[++i];
        else if (argv[i] === '--model') parsed.model = argv[++i];
    }
    return parsed;
}

function fail(message: string): never {
    console.error(`❌ ${message}`);
    process.exit(1);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (!args.org) {
        fail('Falta --org <organization_id>.\n   Uso: pnpm tsx scripts/jev-smoke-test.ts --org <id> [--model ~typesafe/jev-latest]');
    }
    if (args.model && !JEV_MODEL_SLUG_PATTERN.test(args.model)) {
        fail(`--model '${args.model}' no tiene la forma "autor/modelo" de OpenRouter.`);
    }
    const organizationId = args.org;

    const fastify = Fastify({ logger: { level: 'warn' } });
    await fastify.register(supabasePlugin);
    await fastify.ready();

    try {
        const { data: org } = await fastify.supabaseAdmin
            .from('organizations')
            .select('id, name')
            .eq('id', organizationId)
            .maybeSingle();
        if (!org) fail(`No existe la organización '${organizationId}'.`);
        console.log(`🏢 Organización: ${org.name} (${org.id})\n`);

        // 1. Tarifas
        const now = new Date();
        for (const unitType of Object.values(JEV_USAGE_UNIT_TYPES)) {
            const rate = await getRate(fastify, USAGE_EVENT_PROVIDERS.JEV, unitType, now);
            if (!rate) fail(`Sin tarifa vigente en provider_rates para jev/${unitType}. ¿Se aplicó la migración 73?`);
            console.log(`✅ 1. Tarifa jev/${unitType}: ${rate.unitRateUsd} USD`);
        }

        // 2. Modelo
        const current = await getJevConfig(fastify, organizationId);
        const model = args.model ?? current.model ?? DEFAULT_MODEL;
        if (model !== current.model) {
            const saved = await updateJevConfig(fastify, organizationId, { model });
            if (!saved.success) fail(saved.error ?? 'No se pudo guardar el modelo.');
            console.log(`✅ 2. Modelo guardado en integration_settings.jev: ${model}`);
        } else {
            console.log(`✅ 2. Modelo ya configurado: ${model}`);
        }

        // 3. Validación de la llave
        const validation = await validateJevCredentials(fastify, organizationId);
        if (!validation.success) fail(`3. Validación de la llave: [${validation.kind}] ${validation.error}`);
        console.log(`✅ 3. Llave de OpenRouter válida (validatedAt ${validation.validatedAt})`);

        // 4. Decisión real
        const startedAt = new Date();
        const t0 = performance.now();
        const outcome = await evaluateJevDecision(fastify, organizationId, { state: STATE, questions: QUESTIONS });
        const elapsedMs = Math.round(performance.now() - t0);
        if (!outcome.ok) fail(`4. Decisión con Jev: ${outcome.reason} (detalle en el log de arriba)`);
        const { is_urgent, department, frustration } = outcome.answers;
        console.log(`✅ 4. Decisión en ${elapsedMs} ms con ${outcome.model}`);
        console.log(`      is_urgent.noul       = ${is_urgent.noul}`);
        console.log(`      department.choice    = ${department.choice} (confianza ${department.confidence ?? 'n/d'})`);
        console.log(`      department.probs     = ${JSON.stringify(department.probabilities)}`);
        console.log(`      frustration.score    = ${frustration.score} (confianza ${frustration.confidence ?? 'n/d'})`);
        console.log(
            `      usage                = ${outcome.usage.inputTokens} in / ${outcome.usage.outputTokens} out, ` +
                `costo OpenRouter ${outcome.usage.costUsd ?? 'n/d'} USD`
        );

        // 5. Metering
        const { data: rows, error: rowsError } = await fastify.supabaseAdmin
            .from('usage_events')
            .select('unit_type, quantity, unit_rate_usd, amount_usd, metadata')
            .eq('organization_id', organizationId)
            .eq('provider', USAGE_EVENT_PROVIDERS.JEV)
            .gte('occurred_at', startedAt.toISOString());
        if (rowsError) fail(`5. No se pudo leer usage_events: ${rowsError.message}`);
        const expected = [outcome.usage.inputTokens, outcome.usage.outputTokens].filter((q) => q > 0).length;
        if ((rows ?? []).length !== expected) {
            fail(`5. Se esperaban ${expected} asientos 'jev' en usage_events y hay ${(rows ?? []).length}.`);
        }
        console.log(`✅ 5. ${expected} asiento(s) en usage_events:`);
        for (const row of rows ?? []) {
            console.log(`      ${row.unit_type}: ${row.quantity} × ${row.unit_rate_usd} = ${row.amount_usd} USD  ${JSON.stringify(row.metadata)}`);
        }

        console.log('\n🎉 Jev funciona de punta a punta para esta organización.');
    } finally {
        await fastify.close();
    }
}

main().catch((err) => {
    console.error('❌ Error inesperado:', err);
    process.exit(1);
});
