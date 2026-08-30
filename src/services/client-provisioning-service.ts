import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { supabaseAdmin } from '../lib/supabase.js';
import { issueLicense } from './license-service.js';
import { validateEnv } from '../config/env.js';

export interface ProvisionClientParams {
    deploymentId: string;
    organizationName: string;
    organizationEmail: string;
    planKey?: string;
    targetDatabaseUrl: string;
    targetSupabaseUrl: string;
    targetSupabaseSecretKey: string;
    targetSupabasePublishableKey?: string;
    controlPlaneBaseUrl?: string;
    bootstrapSqlPath?: string;
    actorUserId?: string;
}

export interface ProvisionClientResult {
    success: boolean;
    deploymentId: string;
    organizationId: string;
    licenseToken: string;
    adminSessionSecret: string;
    envVarsYaml: string;
    envDotEnv: string;
    completedTasks: string[];
}

/**
 * Servicio de Aprovisionamiento e Inicialización Automatizada de Clientes (DFY / SaaS).
 *
 * Ejecuta:
 * 1. Bootstrap DDL idempotente en la base de datos destino del cliente (PostgreSQL / Supabase).
 * 2. Creación de la fila inicial en `organizations` y `credential_groups`.
 * 3. Emisión de la Licencia Comercial Ed25519 desde el Plano de Control.
 * 4. Siembra de `license_client_state` en la base del cliente.
 * 5. Actualización de `provisioning_tasks` y `deployment_events` en el Plano de Control.
 * 6. Generación del template de variables de entorno para Cloud Run (`env-vars-client.yaml`).
 */
export async function provisionNewClientDeployment(params: ProvisionClientParams): Promise<ProvisionClientResult> {
    const env = validateEnv();
    const {
        deploymentId,
        organizationName,
        organizationEmail,
        targetDatabaseUrl,
        targetSupabaseUrl,
        targetSupabaseSecretKey,
        targetSupabasePublishableKey = '',
        controlPlaneBaseUrl = env.BACKEND_WEBHOOK_URL || 'https://api.datagol.net',
        bootstrapSqlPath = path.resolve(process.cwd(), 'db/client-schema-bootstrap.sql'),
        actorUserId,
    } = params;

    // 1. Validar existencia del despliegue en el Plano de Control
    const { data: deployment, error: depError } = await supabaseAdmin
        .from('deployments')
        .select('id, slug, plan_key, status, customer_id')
        .eq('id', deploymentId)
        .maybeSingle();

    if (depError || !deployment) {
        throw new Error(`El despliegue '${deploymentId}' no existe en el plano de control: ${depError?.message || ''}`);
    }

    const planKey = params.planKey || deployment.plan_key || 'starter';

    // 2. Leer y ejecutar el script SQL maestro en la base de datos destino
    const sqlContent = await fs.readFile(bootstrapSqlPath, 'utf8');
    const clientPool = new pg.Pool({ connectionString: targetDatabaseUrl });

    let clientOrgId: string;
    try {
        const client = await clientPool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sqlContent);

            // 3. Crear o actualizar la Organización y Grupo de Credenciales del Cliente
            const orgCheck = await client.query(
                'SELECT id FROM public.organizations WHERE email = $1 LIMIT 1',
                [organizationEmail]
            );

            if (orgCheck.rows.length > 0) {
                clientOrgId = orgCheck.rows[0].id;
                await client.query(
                    'UPDATE public.organizations SET name = $1, plan_key = $2, updated_at = now() WHERE id = $3',
                    [organizationName, planKey, clientOrgId]
                );
            } else {
                const credGroupRes = await client.query(
                    'INSERT INTO public.credential_groups (name) VALUES ($1) RETURNING id',
                    [organizationName]
                );
                const credGroupId = credGroupRes.rows[0].id;

                const orgRes = await client.query(
                    `INSERT INTO public.organizations 
                        (name, email, plan_key, credential_group_id, status) 
                     VALUES ($1, $2, $3, $4, 'active') 
                     RETURNING id`,
                    [organizationName, organizationEmail, planKey, credGroupId]
                );
                clientOrgId = orgRes.rows[0].id;

                await client.query(
                    'UPDATE public.credential_groups SET owner_organization_id = $1 WHERE id = $2',
                    [clientOrgId, credGroupId]
                );
            }

            await client.query('COMMIT');
        } catch (dbErr) {
            await client.query('ROLLBACK');
            throw dbErr;
        } finally {
            client.release();
        }
    } finally {
        await clientPool.end();
    }

    // 4. Emitir Licencia Comercial en el Plano de Control
    // Mock Fastify context para invocar issueLicense
    const fakeFastify: any = {
        supabaseAdmin,
        log: { info: () => {}, warn: () => {}, error: () => {} },
    };

    const issueResult = await issueLicense(fakeFastify, {
        deploymentId,
        actorUserId,
    });

    // 5. Sembrar la Licencia en `license_client_state` de la base del cliente
    const seedClient = new pg.Client({ connectionString: targetDatabaseUrl });
    await seedClient.connect();
    try {
        await seedClient.query(
            `UPDATE public.license_client_state SET
                deployment_id = $1,
                deployment_slug = $2,
                token = $3,
                key_version = $4,
                plan_key = $5,
                issued_at = $6,
                expires_at = $7,
                warn_after_days = $8,
                limit_features_after_days = $9,
                lock_dashboard_after_days = $10,
                updated_at = now()
             WHERE id = true`,
            [
                deployment.id,
                deployment.slug,
                issueResult.rawToken,
                issueResult.license.key_version,
                planKey,
                issueResult.license.issued_at,
                issueResult.license.expires_at,
                issueResult.license.warn_after_days,
                issueResult.license.limit_features_after_days,
                issueResult.license.lock_dashboard_after_days,
            ]
        );
    } finally {
        await seedClient.end();
    }

    // 6. Actualizar tareas de aprovisionamiento en el Plano de Control
    const completedTasks = ['infra_desplegada', 'licencia_emitida', 'contrato_firmado'];
    await supabaseAdmin
        .from('provisioning_tasks')
        .update({ status: 'completada', completed_at: new Date().toISOString() })
        .eq('deployment_id', deploymentId)
        .in('task_key', completedTasks);

    await supabaseAdmin
        .from('deployments')
        .update({ status: 'aprovisionando', activated_at: new Date().toISOString() })
        .eq('id', deploymentId);

    // 7. Generar secreto simétrico para SSO local y plantillas de variables
    const adminSessionSecret = crypto.randomBytes(32).toString('hex');
    const licensePublicKeys = env.LICENSE_PUBLIC_KEYS || '{}';
    const adminPassportPublicKeys = env.ADMIN_PASSPORT_PUBLIC_KEYS || '{}';

    const envVarsYaml = `# =============================================================================
# VARIABLES DE ENTORNO — INSTALACIÓN CLIENTE: ${deployment.slug}
# =============================================================================
CONTROL_PLANE: "false"
DEPLOYMENT_ID: "${deployment.id}"
CONTROL_PLANE_URL: "${controlPlaneBaseUrl}"
ADMIN_SESSION_SECRET: "${adminSessionSecret}"
LICENSE_PUBLIC_KEYS: ${JSON.stringify(licensePublicKeys)}
ADMIN_PASSPORT_PUBLIC_KEYS: ${JSON.stringify(adminPassportPublicKeys)}

# Base de datos Supabase del Cliente
SUPABASE_URL: "${targetSupabaseUrl}"
SUPABASE_SECRET_KEY: "${targetSupabaseSecretKey}"
SUPABASE_PUBLISHABLE_KEY: "${targetSupabasePublishableKey}"
DATABASE_URL: "${targetDatabaseUrl}"

# Configuración operativa base
DEFAULT_VOICE_PROVIDER: "elevenlabs"
PORT: "8080"
HOST: "0.0.0.0"
`;

    const envDotEnv = `CONTROL_PLANE=false
DEPLOYMENT_ID=${deployment.id}
CONTROL_PLANE_URL=${controlPlaneBaseUrl}
ADMIN_SESSION_SECRET=${adminSessionSecret}
LICENSE_PUBLIC_KEYS=${JSON.stringify(licensePublicKeys)}
ADMIN_PASSPORT_PUBLIC_KEYS=${JSON.stringify(adminPassportPublicKeys)}
SUPABASE_URL=${targetSupabaseUrl}
SUPABASE_SECRET_KEY=${targetSupabaseSecretKey}
SUPABASE_PUBLISHABLE_KEY=${targetSupabasePublishableKey}
DATABASE_URL=${targetDatabaseUrl}
DEFAULT_VOICE_PROVIDER=elevenlabs
PORT=3000
HOST=0.0.0.0
`;

    return {
        success: true,
        deploymentId,
        organizationId: clientOrgId,
        licenseToken: issueResult.rawToken,
        adminSessionSecret,
        envVarsYaml,
        envDotEnv,
        completedTasks,
    };
}
