import { supabaseAdmin } from '../../src/lib/supabase.js';

/**
 * Fixtures reales (no mockeados) de `customers`/`deployments` para las
 * pruebas de integración de `/control/**` — mismo criterio del resto del
 * repo (__tests__/waitlist-confirmation.test.ts): se crea contra el
 * Supabase real y se limpia en `afterAll`.
 */
let counter = 0;

export async function createTestCustomer(overrides: Record<string, unknown> = {}) {
    counter += 1;
    const suffix = `${Date.now()}-${counter}`;
    const { data, error } = await supabaseAdmin
        .from('customers')
        .insert({
            legal_name: `Cliente de prueba ${suffix}`,
            contact_name: 'Persona de Contacto',
            contact_email: `contacto-${suffix}@example.invalid`,
            ...overrides,
        })
        .select('*')
        .single();

    if (error || !data) throw new Error(`No se pudo crear customer de prueba: ${error?.message}`);
    return data;
}

export async function createTestDeployment(customerId: string, overrides: Record<string, unknown> = {}) {
    counter += 1;
    const suffix = `${Date.now()}-${counter}`;
    const { data, error } = await supabaseAdmin
        .from('deployments')
        .insert({
            customer_id: customerId,
            slug: `demo-test-${suffix}`,
            plan_key: 'pro',
            ...overrides,
        })
        .select('*')
        .single();

    if (error || !data) throw new Error(`No se pudo crear deployment de prueba: ${error?.message}`);
    return data;
}

export async function cleanupDeployment(deploymentId: string): Promise<void> {
    await supabaseAdmin.from('license_heartbeats').delete().eq('deployment_id', deploymentId);
    await supabaseAdmin.from('licenses').delete().eq('deployment_id', deploymentId);
    await supabaseAdmin.from('deployment_events').delete().eq('deployment_id', deploymentId);
    await supabaseAdmin.from('provisioning_tasks').delete().eq('deployment_id', deploymentId);
    const { data: contracts } = await supabaseAdmin.from('contracts').select('id').eq('deployment_id', deploymentId);
    if (contracts?.length) {
        await supabaseAdmin
            .from('contract_otp_codes')
            .delete()
            .in('contract_id', contracts.map((c) => c.id));
        await supabaseAdmin.from('contracts').delete().eq('deployment_id', deploymentId);
    }
    await supabaseAdmin.from('deployments').delete().eq('id', deploymentId);
}

export async function cleanupCustomer(customerId: string): Promise<void> {
    await supabaseAdmin.from('customers').delete().eq('id', customerId);
}
