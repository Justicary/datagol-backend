import { supabaseAdmin } from '../../src/lib/supabase.js';
import { deleteTestCustomers, deleteTestDeployments } from './test-data-sweeper.js';

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

/** Falla si no logra borrarlo: un `afterAll` que ignora el error deja basura en silencio. */
export async function cleanupDeployment(deploymentId: string): Promise<void> {
    await deleteTestDeployments(supabaseAdmin, [deploymentId]);
}

export async function cleanupCustomer(customerId: string): Promise<void> {
    await deleteTestCustomers(supabaseAdmin, [customerId]);
}
