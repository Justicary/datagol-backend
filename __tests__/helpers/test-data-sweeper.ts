import type { SupabaseClient } from '@supabase/supabase-js';
import { TEST_PLAN_PREFIX, deleteTestPlan } from './test-plan.js';

/**
 * Dominio reservado (RFC 2606) que identifica a toda organización y usuario
 * creados por pruebas. Ninguna organización real puede usarlo.
 */
export const TEST_EMAIL_DOMAIN = '@example.invalid';

export interface SweepResult {
    organizations: number;
    users: number;
    orphanCatalogs: number;
    customers: number;
    plans: number;
    /** Lo que no se pudo borrar (p. ej. un usuario referenciado por una FK sin cascada). */
    failures: string[];
}

/**
 * Elimina datos de prueba que quedaron en la base porque el proceso que los
 * creó murió antes de su `afterAll` (Stryker mata runners por timeout, Ctrl+C,
 * un crash del worker). Solo toca:
 *
 * - organizaciones con correo `@example.invalid` (el `DELETE` cascadea a sus
 *   contactos, catálogos, cotizaciones, secretos, etc.);
 * - clientes del plano de control (`customers`) con correo de contacto
 *   `@example.invalid`, junto con sus despliegues;
 * - planes inventados (`test-plan-*`, ver helpers/test-plan.ts), después de
 *   borrar las organizaciones que los usaban;
 * - usuarios de Auth con correo `@example.invalid`;
 * - catálogos cuyo `owner_organization_id` ya no existe (la FK con cascada los
 *   hace imposibles en operación normal: si existen, son basura).
 *
 * Es de mejor esfuerzo: un borrado que falla se reporta en `failures` y no
 * detiene la corrida de pruebas.
 *
 * `olderThanMinutes` protege a otra suite que esté corriendo en paralelo
 * contra la misma base (p. ej. los runners concurrentes de Stryker): solo se
 * borra lo creado antes del umbral.
 */
export async function sweepLeakedTestData(
    supabase: SupabaseClient,
    olderThanMinutes: number
): Promise<SweepResult> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
    const result: SweepResult = { organizations: 0, users: 0, orphanCatalogs: 0, customers: 0, plans: 0, failures: [] };

    const { data: orgs, error: orgsErr } = await supabase
        .from('organizations')
        .select('id')
        .ilike('email', `%${TEST_EMAIL_DOMAIN}`)
        .lt('created_at', cutoff);
    if (orgsErr) throw new Error(`No se pudieron listar organizaciones de prueba: ${orgsErr.message}`);

    for (const org of orgs ?? []) {
        try {
            await deleteTestOrganizations(supabase, [org.id as string]);
            result.organizations += 1;
        } catch (err) {
            result.failures.push(err instanceof Error ? err.message : String(err));
        }
    }

    const { data: plans, error: plansErr } = await supabase
        .from('plans')
        .select('key')
        .like('key', `${TEST_PLAN_PREFIX}%`)
        .lt('created_at', cutoff);
    if (plansErr) throw new Error(`No se pudieron listar planes de prueba: ${plansErr.message}`);

    for (const plan of plans ?? []) {
        try {
            await deleteTestPlan(supabase, plan.key as string);
            result.plans += 1;
        } catch (err) {
            result.failures.push(err instanceof Error ? err.message : String(err));
        }
    }

    const { data: customers, error: custErr } = await supabase
        .from('customers')
        .select('id')
        .ilike('contact_email', `%${TEST_EMAIL_DOMAIN}`)
        .lt('created_at', cutoff);
    if (custErr) throw new Error(`No se pudieron listar clientes de prueba: ${custErr.message}`);

    for (const customer of customers ?? []) {
        try {
            const { data: deployments, error: depErr } = await supabase
                .from('deployments')
                .select('id')
                .eq('customer_id', customer.id);
            if (depErr) throw new Error(`despliegues del cliente ${customer.id}: ${depErr.message}`);
            await deleteTestDeployments(supabase, (deployments ?? []).map((d) => d.id as string));
            await deleteTestCustomers(supabase, [customer.id as string]);
            result.customers += 1;
        } catch (err) {
            result.failures.push(err instanceof Error ? err.message : String(err));
        }
    }

    for (let page = 1; ; page += 1) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw new Error(`No se pudieron listar usuarios de prueba: ${error.message}`);
        const leaked = data.users.filter(
            (u) => u.email?.toLowerCase().endsWith(TEST_EMAIL_DOMAIN) && u.created_at < cutoff
        );
        for (const user of leaked) {
            const { error: delErr } = await supabase.auth.admin.deleteUser(user.id);
            if (delErr) result.failures.push(`usuario ${user.email}: HTTP ${delErr.status ?? '?'} ${delErr.message}`);
            else result.users += 1;
        }
        if (data.users.length < 1000) break;
    }

    const [{ data: catalogs, error: catErr }, { data: allOrgs, error: allOrgsErr }] = await Promise.all([
        supabase.from('catalogs').select('id, owner_organization_id'),
        supabase.from('organizations').select('id'),
    ]);
    if (catErr || allOrgsErr) {
        throw new Error(`No se pudieron listar catálogos: ${catErr?.message ?? allOrgsErr?.message}`);
    }
    const orgIds = new Set((allOrgs ?? []).map((o) => o.id as string));
    for (const catalog of catalogs ?? []) {
        if (orgIds.has(catalog.owner_organization_id as string)) continue;
        const { error } = await supabase.from('catalogs').delete().eq('id', catalog.id);
        if (error) result.failures.push(`catálogo huérfano ${catalog.id}: ${error.message}`);
        else result.orphanCatalogs += 1;
    }

    return result;
}

/**
 * Borra organizaciones de prueba (cascada a todo lo suyo) y falla si alguna
 * no se pudo borrar: un `afterAll` que ignora el error deja basura en silencio.
 *
 * Si la organización tiene filas append-only (p. ej. `usage_events`), su
 * trigger bloquea el DELETE en cascada; entonces se recurre a
 * `admin_delete_organizations_cascade`, que borra esas filas y deja que las
 * FKs con cascada eliminen el resto (migración 78).
 */
export async function deleteTestOrganizations(
    supabase: SupabaseClient,
    organizationIds: Array<string | undefined | null>
): Promise<void> {
    for (const id of organizationIds) {
        if (!id) continue;
        const { error } = await supabase.from('organizations').delete().eq('id', id);
        if (!error) continue;

        const { error: rpcErr } = await supabase.rpc('admin_delete_organizations_cascade', {
            p_organization_ids: [id],
        });
        if (rpcErr) {
            throw new Error(
                `No se pudo borrar la organización de prueba ${id}: ${error.message} / ${rpcErr.message}`
            );
        }
    }
}

/**
 * Borra despliegues de prueba del plano de control y falla si alguno no se
 * pudo borrar. `licenses` y `contracts` lo referencian con ON DELETE RESTRICT,
 * así que van primero (sus latidos y códigos OTP caen en cascada); el DELETE
 * del despliegue arrastra sus eventos y tareas (migración 80).
 */
export async function deleteTestDeployments(
    supabase: SupabaseClient,
    deploymentIds: Array<string | undefined | null>
): Promise<void> {
    for (const id of deploymentIds) {
        if (!id) continue;
        for (const table of ['licenses', 'contracts', 'deployments'] as const) {
            const column = table === 'deployments' ? 'id' : 'deployment_id';
            const { error } = await supabase.from(table).delete().eq(column, id);
            if (error) throw new Error(`No se pudo borrar el despliegue de prueba ${id} (${table}): ${error.message}`);
        }
    }
}

/** Borra clientes de prueba del plano de control (sin despliegues) y falla si alguno no se pudo borrar. */
export async function deleteTestCustomers(
    supabase: SupabaseClient,
    customerIds: Array<string | undefined | null>
): Promise<void> {
    for (const id of customerIds) {
        if (!id) continue;
        const { error } = await supabase.from('customers').delete().eq('id', id);
        if (error) throw new Error(`No se pudo borrar el cliente de prueba ${id}: ${error.message}`);
    }
}

/** Borra usuarios de Auth de prueba y falla si alguno no se pudo borrar. */
export async function deleteTestUsers(
    supabase: SupabaseClient,
    userIds: Array<string | undefined | null>
): Promise<void> {
    for (const id of userIds) {
        if (!id) continue;
        const { error } = await supabase.auth.admin.deleteUser(id);
        if (error) throw new Error(`No se pudo borrar el usuario de prueba ${id}: ${error.message}`);
    }
}
