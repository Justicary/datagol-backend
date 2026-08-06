import crypto from 'crypto';
import { setSecret } from '../src/services/secret-service.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { ALL_SECRET_KEYS, isSecretKey, SECRET_KEYS } from '../src/types/secret-keys.js';

/**
 * Script de alta de secretos y configuración de webhook por organización.
 * Se ejecuta desde Node (`pnpm tsx scripts/provision-org-secrets.ts ...`),
 * nunca desde el editor SQL de Supabase — igual que scripts/migrate-secrets.ts.
 *
 * Dos subcomandos:
 *   secret        — da de alta cualquier entrada de `organization_secrets`
 *                    reutilizando el servicio `setSecret` (Vault).
 *   webhook-token — da de alta `organizations.webhook_token`, el
 *                    identificador de enrutamiento del webhook de ElevenLabs
 *                    (NO es un secreto de organization_secrets: ver
 *                    db/migrations/04_organizations_webhook_token.sql).
 *
 * El alta de webhook_token y de webhook_signing_secret es un paso
 * obligatorio del onboarding de cada organización: sin ambos, el webhook de
 * post-llamada de ElevenLabs responde 401 a toda entrega.
 */

interface ParsedArgs {
    command?: string;
    org?: string;
    key?: string;
    value?: string;
    generate: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
    const [command, ...rest] = argv;
    const parsed: ParsedArgs = { command, generate: false };
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === '--org') parsed.org = rest[++i];
        else if (arg === '--key') parsed.key = rest[++i];
        else if (arg === '--value') parsed.value = rest[++i];
        else if (arg === '--generate') parsed.generate = true;
    }
    return parsed;
}

function generateRandomValue(): string {
    return crypto.randomBytes(32).toString('hex');
}

function printUsage(): void {
    console.log(`
Uso:
  pnpm tsx scripts/provision-org-secrets.ts secret --org <organization_id> --key <secret_key> [--value <valor> | --generate]
  pnpm tsx scripts/provision-org-secrets.ts webhook-token --org <organization_id> [--value <token> | --generate]

Claves válidas de secret_key en organization_secrets (src/types/secret-keys.ts):
  ${ALL_SECRET_KEYS.join(', ')}

Onboarding típico del webhook de ElevenLabs para una organización nueva:
  pnpm tsx scripts/provision-org-secrets.ts webhook-token --org <id> --generate
  pnpm tsx scripts/provision-org-secrets.ts secret --org <id> --key ${SECRET_KEYS.WEBHOOK_SIGNING_SECRET} --generate
`);
}

async function findOrganization(orgId: string): Promise<{ id: string; name: string } | null> {
    const { data, error } = await supabaseAdmin
        .from('organizations')
        .select('id, name')
        .eq('id', orgId)
        .maybeSingle();

    if (error || !data) return null;
    return data as { id: string; name: string };
}

async function provisionSecret(args: ParsedArgs): Promise<void> {
    if (!args.org || !args.key) {
        console.error('❌ Faltan --org y/o --key.');
        printUsage();
        process.exit(1);
    }

    if (!isSecretKey(args.key!)) {
        console.error(`❌ '${args.key}' no es una clave válida. Claves permitidas: ${ALL_SECRET_KEYS.join(', ')}`);
        process.exit(1);
    }

    const value = args.value || (args.generate ? generateRandomValue() : null);
    if (!value) {
        console.error('❌ Debes pasar --value <valor> o --generate.');
        process.exit(1);
    }

    const org = await findOrganization(args.org!);
    if (!org) {
        console.error(`❌ No existe la organización '${args.org}'.`);
        process.exit(1);
    }

    const ok = await setSecret(org.id, args.key, value);
    if (!ok) {
        console.error(
            `❌ No se pudo guardar el secreto '${args.key}' para '${org.name}'. ` +
                'Revisa que Vault esté accesible.'
        );
        process.exit(1);
    }

    console.log(`✅ Secreto '${args.key}' dado de alta para '${org.name}' (${org.id}).`);
    if (args.generate) {
        console.log(`   Valor generado (guárdalo, no se puede volver a mostrar): ${value}`);
    }
}

async function provisionWebhookToken(args: ParsedArgs): Promise<void> {
    if (!args.org) {
        console.error('❌ Falta --org.');
        printUsage();
        process.exit(1);
    }

    if (!args.value && !args.generate) {
        console.error('❌ Debes pasar --value <token> o --generate.');
        process.exit(1);
    }

    const org = await findOrganization(args.org!);
    if (!org) {
        console.error(`❌ No existe la organización '${args.org}'.`);
        process.exit(1);
    }

    const token = args.value || generateRandomValue();

    const { error: updateError } = await supabaseAdmin
        .from('organizations')
        .update({ webhook_token: token })
        .eq('id', org.id);

    if (updateError) {
        console.error(`❌ No se pudo guardar webhook_token: ${updateError.message}`);
        process.exit(1);
    }

    const baseUrl = process.env.BACKEND_WEBHOOK_URL || '<BACKEND_WEBHOOK_URL>';
    console.log(`✅ webhook_token dado de alta para '${org.name}' (${org.id}).`);
    console.log('   URL a configurar como webhook de post-llamada en el dashboard de ElevenLabs:');
    console.log(`   ${baseUrl}/webhooks/elevenlabs/${token}`);
    console.log('   No olvides dar de alta también el secreto de firma:');
    console.log(`   pnpm tsx scripts/provision-org-secrets.ts secret --org ${org.id} --key ${SECRET_KEYS.WEBHOOK_SIGNING_SECRET} --generate`);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (args.command === 'secret') {
        await provisionSecret(args);
    } else if (args.command === 'webhook-token') {
        await provisionWebhookToken(args);
    } else {
        printUsage();
        process.exit(args.command ? 1 : 0);
    }
}

main().catch((err) => {
    console.error('❌ Error inesperado:', err);
    process.exit(1);
});
