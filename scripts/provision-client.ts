#!/usr/bin/env node

/**
 * DATAGOL — CLI de Aprovisionamiento Automatizado de Clientes
 *
 * Uso:
 *   npx tsx scripts/provision-client.ts \
 *     --deployment-id="<UUID>" \
 *     --org-name="Clínica Dental Norte" \
 *     --org-email="contacto@dentalnorte.com" \
 *     --db-url="postgresql://postgres:[PASSWORD]@db.cliente.supabase.co:5432/postgres" \
 *     --supabase-url="https://xyz.supabase.co" \
 *     --supabase-key="sb_secret_..."
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { provisionNewClientDeployment } from '../src/services/client-provisioning-service.js';

function parseArgs(): Record<string, string> {
    const args: Record<string, string> = {};
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg.startsWith('--')) {
            const [key, ...valueParts] = arg.slice(2).split('=');
            if (valueParts.length > 0) {
                args[key] = valueParts.join('=');
            } else if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
                args[key] = process.argv[++i];
            }
        }
    }
    return args;
}

async function main() {
    const args = parseArgs();

    const deploymentId = args['deployment-id'] || process.env.CLIENT_DEPLOYMENT_ID;
    const organizationName = args['org-name'] || process.env.CLIENT_ORG_NAME;
    const organizationEmail = args['org-email'] || process.env.CLIENT_ORG_EMAIL;
    const targetDatabaseUrl = args['db-url'] || process.env.CLIENT_DATABASE_URL;
    const targetSupabaseUrl = args['supabase-url'] || process.env.CLIENT_SUPABASE_URL;
    const targetSupabaseSecretKey = args['supabase-key'] || process.env.CLIENT_SUPABASE_SECRET_KEY;
    const planKey = args['plan-key'] || process.env.CLIENT_PLAN_KEY;

    if (!deploymentId || !organizationName || !organizationEmail || !targetDatabaseUrl || !targetSupabaseUrl || !targetSupabaseSecretKey) {
        console.error(`
❌ Error: Parámetros obligatorios faltantes.

Uso correcto:
  npx tsx scripts/provision-client.ts \\
    --deployment-id="<UUID_DESPLIEGUE>" \\
    --org-name="Nombre del Cliente" \\
    --org-email="email@cliente.com" \\
    --db-url="postgresql://postgres:PASSWORD@db.xxx.supabase.co:5432/postgres" \\
    --supabase-url="https://xxx.supabase.co" \\
    --supabase-key="sb_secret_xxx" \\
    [--plan-key="pro"]
`);
        process.exit(1);
    }

    console.log('=================================================================');
    console.log('🚀 Iniciando Aprovisionamiento Automatizado de Cliente');
    console.log(`📦 Deployment ID:      ${deploymentId}`);
    console.log(`🏢 Organización:       ${organizationName} (${organizationEmail})`);
    console.log(`🎯 Supabase Destino:   ${targetSupabaseUrl}`);
    console.log('=================================================================');

    try {
        const result = await provisionNewClientDeployment({
            deploymentId,
            organizationName,
            organizationEmail,
            planKey,
            targetDatabaseUrl,
            targetSupabaseUrl,
            targetSupabaseSecretKey,
        });

        console.log('✅ Base de datos inicializada con DDL maestro.');
        console.log(`✅ Organización creada con ID: ${result.organizationId}`);
        console.log('✅ Licencia comercial emitida y sembrada en license_client_state.');
        console.log(`✅ Tareas actualizadas en el Plano de Control: ${result.completedTasks.join(', ')}`);

        // Guardar archivo YAML generado en carpeta local / output
        const outputYamlPath = path.resolve(process.cwd(), `env-vars-${deploymentId.slice(0, 8)}.yaml`);
        await fs.writeFile(outputYamlPath, result.envVarsYaml, 'utf8');

        console.log('=================================================================');
        console.log(`🎉 ¡Aprovisionamiento completado con éxito!`);
        console.log(`📄 Archivo de variables generado: ${outputYamlPath}`);
        console.log('=================================================================');
    } catch (err: any) {
        console.error('❌ Error fatal durante el aprovisionamiento:', err.message || err);
        process.exit(1);
    }
}

main();
