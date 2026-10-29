import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Prefijo de los planes inventados por pruebas; ningún plan real lo usa. */
export const TEST_PLAN_PREFIX = 'test-plan-';

/**
 * Crea un plan inventado con exactamente las features indicadas
 * (`true` = habilitada, `false` = fila explícita deshabilitada; las que no se
 * listan no existen en el plan, es decir, denegadas por defecto).
 *
 * Las pruebas no deben depender del contenido de un plan real (`starter`,
 * `pro`, ...): el superadmin lo cambia desde el panel y la prueba se rompe o,
 * peor, se escribe sobre una tabla compartida. Ver feedback de higiene en
 * docs/control-plane-tech-manual.md.
 */
export async function createTestPlan(
    supabase: SupabaseClient,
    features: Record<string, boolean> = {}
): Promise<string> {
    const key = `${TEST_PLAN_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
    const { error: planErr } = await supabase.from('plans').insert({
        key,
        name: `Plan de prueba ${key}`,
        setup_fee_mxn: 1,
        monthly_fee_mxn: null,
        max_concurrent_calls: 1,
        is_active: false,
        sort_order: 999,
        target_audience: 'Prueba',
        cta_text: 'CTA de prueba',
    });
    if (planErr) throw new Error(`No se pudo crear el plan de prueba: ${planErr.message}`);

    const rows = Object.entries(features).map(([feature_key, enabled]) => ({ plan_key: key, feature_key, enabled }));
    if (rows.length > 0) {
        const { error: pfErr } = await supabase.from('plan_features').insert(rows);
        if (pfErr) {
            await deleteTestPlan(supabase, key);
            throw new Error(`No se pudieron crear las features del plan de prueba: ${pfErr.message}`);
        }
    }
    return key;
}

/**
 * Borra un plan inventado y sus features. Se niega a tocar un plan real y
 * falla si no logra borrarlo. Las organizaciones que lo usan deben borrarse
 * antes (organizations.plan_key es FK a plans).
 */
export async function deleteTestPlan(supabase: SupabaseClient, key: string | undefined | null): Promise<void> {
    if (!key) return;
    if (!key.startsWith(TEST_PLAN_PREFIX)) throw new Error(`Se rechazó borrar el plan real '${key}' desde una prueba`);

    const { error: pfErr } = await supabase.from('plan_features').delete().eq('plan_key', key);
    if (pfErr) throw new Error(`No se pudieron borrar las features del plan de prueba ${key}: ${pfErr.message}`);
    const { error } = await supabase.from('plans').delete().eq('key', key);
    if (error) throw new Error(`No se pudo borrar el plan de prueba ${key}: ${error.message}`);
}
