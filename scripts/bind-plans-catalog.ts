import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * Script de vinculación y proyección de planes al catálogo administrado.
 * Implementa la Fase B2 del Manual Técnico (docs/quotations-tech-manual.md §3).
 *
 * Crea el catálogo 'Planes Datagol' con `managed_source = 'datagol_plans'`
 * en la organización indicada y proyecta todos los registros de `plans` hacia
 * `products` y `product_variants`.
 */
async function main() {
    const args = process.argv.slice(2);
    let token = 'b05e8d6ec8801a7124c989330104579c9490b3e06bf02a2bdf404d879564a831';
    let orgId = process.env.ORG_ID;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--token' && args[i + 1]) token = args[++i];
        if (args[i] === '--org' && args[i + 1]) orgId = args[++i];
    }

    console.log('🔄 Iniciando vinculación de Planes al Catálogo de Productos...');

    // 1. Resolver organización
    let targetOrgId = orgId;
    if (!targetOrgId) {
        const { data: org, error: orgErr } = await supabaseAdmin
            .from('organizations')
            .select('id, name')
            .eq('webhook_token', token)
            .maybeSingle();

        if (orgErr || !org) {
            console.error('❌ Error resolviendo la organización por webhook_token:', orgErr?.message ?? 'No encontrada');
            process.exit(1);
        }
        targetOrgId = org.id as string;
        console.log(`🏢 Organización encontrada: ${org.name} (${targetOrgId})`);
    }

    // 2. Buscar o crear catálogo administrado
    const { data: existingCat } = await supabaseAdmin
        .from('catalogs')
        .select('id, name, managed_source')
        .eq('managed_source', 'datagol_plans')
        .maybeSingle();

    let catalogId = existingCat?.id as string | undefined;

    if (!catalogId) {
        console.log('📦 Creando catálogo administrado "Planes Datagol"...');
        const { data: newCat, error: catErr } = await supabaseAdmin
            .from('catalogs')
            .insert({
                owner_organization_id: targetOrgId,
                name: 'Planes Datagol',
                description: 'Catálogo administrado proyectado automáticamente desde la tabla plans.',
                is_shared: false,
                managed_source: 'datagol_plans',
            })
            .select('id')
            .single();

        if (catErr || !newCat) {
            console.error('❌ Error creando el catálogo administrado:', catErr?.message);
            process.exit(1);
        }
        catalogId = newCat.id as string;
        console.log(`✅ Catálogo creado con ID: ${catalogId}`);
    } else {
        console.log(`ℹ️ Catálogo existente encontrado con ID: ${catalogId}`);
    }

    // 3. Proyectar todos los planes mediante la RPC sync_plan_to_catalog
    const { data: plans, error: plansErr } = await supabaseAdmin
        .from('plans')
        .select('key, name')
        .order('sort_order', { ascending: true });

    if (plansErr || !plans) {
        console.error('❌ Error leyendo la tabla plans:', plansErr?.message);
        process.exit(1);
    }

    console.log(`📋 Proyectando ${plans.length} planes al catálogo...`);
    for (const plan of plans) {
        const { error: syncErr } = await supabaseAdmin.rpc('sync_plan_to_catalog', {
            p_plan_key: plan.key,
        });

        if (syncErr) {
            console.error(`❌ Error sincronizando el plan "${plan.key}":`, syncErr.message);
        } else {
            console.log(`  ✓ Plan sincronizado: ${plan.name} (${plan.key})`);
        }
    }

    // 4. Resumen final de productos y variantes proyectadas
    const { data: prods } = await supabaseAdmin
        .from('products')
        .select('id, name, item_type')
        .eq('catalog_id', catalogId);

    const { data: variants } = await supabaseAdmin
        .from('product_variants')
        .select('sku, price, billing_period')
        .eq('catalog_id', catalogId);

    console.log('\n🎉 ¡Vinculación completada con éxito!');
    console.log(`Total productos proyectados: ${prods?.length ?? 0}`);
    console.log(`Total variantes activas: ${variants?.length ?? 0}`);
    console.log('Variantes listas para cotizar:');
    for (const v of variants ?? []) {
        console.log(`  • SKU: ${v.sku} | $${v.price} | Periodo: ${v.billing_period}`);
    }
}

main().catch((err) => {
    console.error('Error fatal:', err);
    process.exit(1);
});

