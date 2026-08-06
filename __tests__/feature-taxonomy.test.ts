import { describe, it, expect } from 'vitest';
import { ALL_FEATURE_CATEGORIES, ALL_PLAN_KEYS, ALL_FEATURE_KEYS } from '../src/types/feature-taxonomy.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

describe('src/types/feature-taxonomy.ts — sincronizado con la base real', () => {
    // features.category tiene CHECK constraint: se verifica insertando.
    it.each(ALL_FEATURE_CATEGORIES)('la categoría "%s" es aceptada por features_category_check', async (category) => {
        const key = `diag_feat_${Math.random().toString(36).slice(2)}`;
        const { error } = await supabaseAdmin
            .from('features')
            .insert({ key, name: 'diag', category })
            .select('key')
            .single();

        expect(error?.code).not.toBe('23514');

        await supabaseAdmin.from('features').delete().eq('key', key);
    });

    // plans.key NO tiene CHECK constraint (PK de texto libre): lo que se
    // verifica es que cada clave declarada exista de verdad como plan real,
    // no que la base la "acepte" (cualquier string se aceptaría).
    it.each(ALL_PLAN_KEYS)('el plan "%s" existe como fila real en plans', async (planKey) => {
        const { data, error } = await supabaseAdmin.from('plans').select('key').eq('key', planKey).maybeSingle();
        expect(error).toBeNull();
        expect(data).not.toBeNull();
    });

    // features.key tampoco tiene CHECK constraint (PK de texto libre): se
    // verifica que cada clave usada por el código (Fase 4) exista de verdad.
    it.each(ALL_FEATURE_KEYS)('la feature "%s" existe como fila real en features', async (featureKey) => {
        const { data, error } = await supabaseAdmin.from('features').select('key').eq('key', featureKey).maybeSingle();
        expect(error).toBeNull();
        expect(data).not.toBeNull();
    });
});
