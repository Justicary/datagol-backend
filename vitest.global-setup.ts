import { config as loadDotenv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { sweepLeakedTestData } from './__tests__/helpers/test-data-sweeper.js';

/**
 * Antes de cada corrida, recoge la basura de corridas anteriores que murieron
 * sin llegar a su `afterAll` (ver __tests__/helpers/test-data-sweeper.ts).
 * El umbral de 30 min evita tocar datos de otra corrida viva contra la misma
 * base (los runners concurrentes de Stryker arrancan cada uno este setup).
 */
export async function setup(): Promise<void> {
    // Se lee .env sin tocar process.env: el globalSetup corre en el proceso
    // principal y vitest hereda su entorno a los workers. Cargarlo aquí haría
    // que vitest.setup.ts vea CONTROL_PLANE_SIGNING_KEYS ya definido (el de
    // .env) y no genere las llaves de prueba.
    const fileEnv: Record<string, string> = {};
    loadDotenv({ processEnv: fileEnv, quiet: true });
    const url = process.env.SUPABASE_URL ?? fileEnv.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY ?? fileEnv.SUPABASE_SECRET_KEY;
    if (!url || !key) return;

    const supabase = createClient(url, key, { auth: { persistSession: false } });
    let swept;
    try {
        swept = await sweepLeakedTestData(supabase, 30);
    } catch (err) {
        // La limpieza nunca debe impedir que corran las pruebas.
        process.stdout.write(`[test-sweeper] Limpieza omitida: ${err instanceof Error ? err.message : String(err)}\n`);
        return;
    }
    if (swept.organizations + swept.users + swept.orphanCatalogs + swept.customers + swept.plans > 0) {
        process.stdout.write(
            `[test-sweeper] Basura de corridas interrumpidas eliminada: ` +
                `${swept.organizations} organizaciones, ${swept.users} usuarios, ` +
                `${swept.orphanCatalogs} catálogos huérfanos, ${swept.customers} clientes del plano de control, ${swept.plans} planes de prueba.\n`
        );
    }
    if (swept.failures.length > 0) {
        process.stdout.write(
            `[test-sweeper] No se pudieron borrar ${swept.failures.length} elementos:\n  ` +
                swept.failures.join('\n  ') +
                '\n'
        );
    }
}
