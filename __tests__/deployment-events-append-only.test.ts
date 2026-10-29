import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { createTestCustomer, createTestDeployment, cleanupDeployment, cleanupCustomer } from './helpers/control-plane-fixtures.js';

/**
 * `deployment_events` es append-only (55_control_plane_datagol.sql), con las
 * dos excepciones de la migración 80: la cascada del borrado del despliegue y
 * el SET NULL del borrado de un usuario. Cada rechazo tiene su contraparte.
 */
describe('deployment_events — append-only con cascada (migración 80, base real)', () => {
    const customerIds: string[] = [];
    const deploymentIds: string[] = [];

    async function createDeploymentWithEvent(actorUserId?: string) {
        const customer = await createTestCustomer();
        customerIds.push(customer.id);
        const deployment = await createTestDeployment(customer.id);
        deploymentIds.push(deployment.id);

        const { data: ev, error } = await supabaseAdmin
            .from('deployment_events')
            .insert({ deployment_id: deployment.id, event_type: 'nota', actor_user_id: actorUserId ?? null })
            .select('id')
            .single();
        if (error || !ev) throw new Error(error?.message);
        return { customerId: customer.id as string, deploymentId: deployment.id as string, eventId: ev.id as string };
    }

    afterAll(async () => {
        const { data: remaining } = await supabaseAdmin.from('deployments').select('id').in('id', deploymentIds);
        for (const d of remaining ?? []) await cleanupDeployment(d.id);
        const { data: remainingCustomers } = await supabaseAdmin.from('customers').select('id').in('id', customerIds);
        for (const c of remainingCustomers ?? []) await cleanupCustomer(c.id);
    });

    it('rechaza UPDATE y DELETE directos de un evento', async () => {
        const { eventId } = await createDeploymentWithEvent();

        const { error: updErr } = await supabaseAdmin
            .from('deployment_events')
            .update({ description: 'reescrita' })
            .eq('id', eventId);
        expect(updErr?.message).toMatch(/append-only/);

        const { error: delErr } = await supabaseAdmin.from('deployment_events').delete().eq('id', eventId);
        expect(delErr?.message).toMatch(/append-only/);

        const { data } = await supabaseAdmin.from('deployment_events').select('description').eq('id', eventId).single();
        expect(data).toEqual({ description: null });
    });

    it('borrar el despliegue arrastra sus eventos en cascada', async () => {
        const { customerId, deploymentId } = await createDeploymentWithEvent();

        const { error } = await supabaseAdmin.from('deployments').delete().eq('id', deploymentId);
        expect(error).toBeNull();

        const { count } = await supabaseAdmin
            .from('deployment_events')
            .select('id', { count: 'exact', head: true })
            .eq('deployment_id', deploymentId);
        expect(count).toBe(0);

        await cleanupCustomer(customerId);
    });

    it('borrar un usuario que actuó sobre un despliegue deja su evento con actor_user_id NULL', async () => {
        const { data: created, error: userErr } = await supabaseAdmin.auth.admin.createUser({
            email: `test-deploy-actor-${crypto.randomUUID()}@example.invalid`,
            password: `Pw-${crypto.randomUUID()}`,
            email_confirm: true,
        });
        if (userErr || !created.user) throw new Error(userErr?.message);
        const { eventId } = await createDeploymentWithEvent(created.user.id);

        const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(created.user.id);
        expect(delErr).toBeNull();

        const { data } = await supabaseAdmin
            .from('deployment_events')
            .select('actor_user_id, event_type')
            .eq('id', eventId)
            .single();
        expect(data).toEqual({ actor_user_id: null, event_type: 'nota' });
    });
});
