import { FastifyInstance } from 'fastify';
import { DEPLOYMENT_STATUSES } from '../schemas/control/customer-schemas.js';

export class DeploymentServiceError extends Error {
    constructor(message: string, public readonly statusCode: number) {
        super(message);
        this.name = 'DeploymentServiceError';
    }
}

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export interface DeploymentInput {
    customerId: string;
    slug: string;
    planKey: string;
    setupFeeMxn?: number | null;
    retainerMxn?: number | null;
    currency?: 'MXN' | 'USD';
    billingPeriod?: 'mensual' | 'anual' | 'unico';
    installUrl?: string | null;
    installRegion?: string | null;
}

function toRow(input: Partial<DeploymentInput>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    if (input.customerId !== undefined) row.customer_id = input.customerId;
    if (input.slug !== undefined) row.slug = input.slug;
    if (input.planKey !== undefined) row.plan_key = input.planKey;
    if (input.setupFeeMxn !== undefined) row.setup_fee_mxn = input.setupFeeMxn;
    if (input.retainerMxn !== undefined) row.retainer_mxn = input.retainerMxn;
    if (input.currency !== undefined) row.currency = input.currency;
    if (input.billingPeriod !== undefined) row.billing_period = input.billingPeriod;
    if (input.installUrl !== undefined) row.install_url = input.installUrl;
    if (input.installRegion !== undefined) row.install_region = input.installRegion;
    return row;
}

async function logDeploymentEvent(
    fastify: FastifyInstance,
    deploymentId: string,
    eventType: string,
    description: string,
    actorUserId: string | undefined,
    metadata: Record<string, unknown> = {},
    previousValue?: string | null,
    newValue?: string | null
): Promise<void> {
    const { error } = await fastify.supabaseAdmin.from('deployment_events').insert({
        deployment_id: deploymentId,
        event_type: eventType,
        description,
        previous_value: previousValue ?? null,
        new_value: newValue ?? null,
        actor_user_id: actorUserId ?? null,
        metadata,
    });

    if (error) {
        fastify.log.error({ err: error.message, deploymentId, eventType }, '[DeploymentService] Error registrando deployment_event');
    }
}

export async function createDeployment(fastify: FastifyInstance, input: DeploymentInput, actorUserId?: string) {
    const { data, error } = await fastify.supabaseAdmin.from('deployments').insert(toRow(input)).select('*').single();

    if (error || !data) {
        throw new DeploymentServiceError(`No se pudo crear el despliegue: ${error?.message ?? 'error desconocido'}`, 400);
    }

    await logDeploymentEvent(fastify, data.id, 'creado', `Despliegue '${data.slug}' creado`, actorUserId);
    return data;
}

export async function getDeployment(fastify: FastifyInstance, deploymentId: string) {
    const { data, error } = await fastify.supabaseAdmin.from('deployments').select('*').eq('id', deploymentId).maybeSingle();

    if (error || !data) {
        throw new DeploymentServiceError(`El despliegue '${deploymentId}' no existe.`, 404);
    }
    return data;
}

export async function listDeployments(fastify: FastifyInstance) {
    const { data, error } = await fastify.supabaseAdmin.from('deployments').select('*').order('created_at', { ascending: false });

    if (error) {
        throw new DeploymentServiceError(`No se pudo listar despliegues: ${error.message}`, 500);
    }
    return data ?? [];
}

export async function updateDeployment(fastify: FastifyInstance, deploymentId: string, input: Partial<DeploymentInput>) {
    const { data, error } = await fastify.supabaseAdmin
        .from('deployments')
        .update(toRow(input))
        .eq('id', deploymentId)
        .select('*')
        .maybeSingle();

    if (error) {
        throw new DeploymentServiceError(`No se pudo actualizar el despliegue: ${error.message}`, 400);
    }
    if (!data) {
        throw new DeploymentServiceError(`El despliegue '${deploymentId}' no existe.`, 404);
    }
    return data;
}

const STATUS_TIMESTAMP_COLUMN: Partial<Record<DeploymentStatus, string>> = {
    contratado: 'contracted_at',
    activo: 'activated_at',
    suspendido: 'suspended_at',
    cancelado: 'cancelled_at',
};

/**
 * Fase C — transición de estado del despliegue. Al pasar a
 * `aprovisionando`, instancia las tareas desde `provisioning_task_templates`
 * filtrando las que no apliquen al plan contratado (`applies_when`: sin
 * valor aplica siempre; con valor, debe coincidir con el `plan_key` del
 * despliegue o con una de sus features habilitadas).
 */
export async function changeDeploymentStatus(
    fastify: FastifyInstance,
    deploymentId: string,
    newStatus: DeploymentStatus,
    reason: string | null | undefined,
    actorUserId?: string
) {
    const deployment = await getDeployment(fastify, deploymentId);
    const previousStatus = deployment.status as DeploymentStatus;

    const timestampColumn = STATUS_TIMESTAMP_COLUMN[newStatus];
    const updatePayload: Record<string, unknown> = { status: newStatus };
    if (timestampColumn) {
        updatePayload[timestampColumn] = new Date().toISOString();
    }
    if (newStatus === 'cancelado' && reason) {
        updatePayload.cancellation_reason = reason;
    }

    const { data, error } = await fastify.supabaseAdmin
        .from('deployments')
        .update(updatePayload)
        .eq('id', deploymentId)
        .select('*')
        .single();

    if (error || !data) {
        throw new DeploymentServiceError(`No se pudo cambiar el estado del despliegue: ${error?.message ?? 'error desconocido'}`, 400);
    }

    await logDeploymentEvent(
        fastify,
        deploymentId,
        'estado_cambiado',
        reason ?? `Estado cambiado de '${previousStatus}' a '${newStatus}'`,
        actorUserId,
        {},
        previousStatus,
        newStatus
    );

    if (newStatus === 'aprovisionando') {
        await instantiateProvisioningTasks(fastify, data.id, data.plan_key);
    }

    return data;
}

async function resolvePlanFeatureKeys(fastify: FastifyInstance, planKey: string): Promise<Set<string>> {
    const { data } = await fastify.supabaseAdmin.from('plan_features').select('feature_key').eq('plan_key', planKey).eq('enabled', true);
    return new Set((data ?? []).map((row) => row.feature_key as string));
}

async function instantiateProvisioningTasks(fastify: FastifyInstance, deploymentId: string, planKey: string): Promise<void> {
    const { data: templates, error } = await fastify.supabaseAdmin
        .from('provisioning_task_templates')
        .select('*')
        .order('sort_order', { ascending: true });

    if (error || !templates) {
        fastify.log.error({ err: error?.message, deploymentId }, '[DeploymentService] No se pudieron leer las plantillas de provisión');
        return;
    }

    const planFeatureKeys = await resolvePlanFeatureKeys(fastify, planKey);

    const applicableTemplates = templates.filter((template) => {
        if (!template.applies_when) return true;
        if (template.applies_when === planKey) return true;
        return planFeatureKeys.has(template.applies_when as string);
    });

    if (applicableTemplates.length === 0) return;

    const rows = applicableTemplates.map((template) => ({
        deployment_id: deploymentId,
        task_key: template.task_key,
        label: template.label,
        description: template.description,
        owner: template.owner,
        is_blocking: template.is_blocking,
        sort_order: template.sort_order,
    }));

    const { error: insertError } = await fastify.supabaseAdmin.from('provisioning_tasks').upsert(rows, { onConflict: 'deployment_id,task_key' });

    if (insertError) {
        fastify.log.error({ err: insertError.message, deploymentId }, '[DeploymentService] No se pudieron instanciar las tareas de provisión');
    }
}

export async function listProvisioningTasks(fastify: FastifyInstance, deploymentId: string) {
    const { data, error } = await fastify.supabaseAdmin
        .from('provisioning_tasks')
        .select('*')
        .eq('deployment_id', deploymentId)
        .order('sort_order', { ascending: true });

    if (error) {
        throw new DeploymentServiceError(`No se pudieron listar las tareas de provisión: ${error.message}`, 500);
    }
    return data ?? [];
}

export interface ProvisioningTaskPatch {
    status: 'pendiente' | 'en_proceso' | 'bloqueada' | 'completada' | 'omitida';
    blockedReason?: string | null;
    notes?: string | null;
}

export async function patchProvisioningTask(
    fastify: FastifyInstance,
    deploymentId: string,
    taskKey: string,
    patch: ProvisioningTaskPatch,
    actorUserId?: string
) {
    const updatePayload: Record<string, unknown> = {
        status: patch.status,
        blocked_reason: patch.status === 'bloqueada' ? (patch.blockedReason ?? null) : null,
    };
    if (patch.notes !== undefined) updatePayload.notes = patch.notes;
    if (patch.status === 'completada') updatePayload.completed_at = new Date().toISOString();

    const { data, error } = await fastify.supabaseAdmin
        .from('provisioning_tasks')
        .update(updatePayload)
        .eq('deployment_id', deploymentId)
        .eq('task_key', taskKey)
        .select('*')
        .maybeSingle();

    if (error) {
        throw new DeploymentServiceError(`No se pudo actualizar la tarea: ${error.message}`, 400);
    }
    if (!data) {
        throw new DeploymentServiceError(`La tarea '${taskKey}' no existe para este despliegue.`, 404);
    }

    if (patch.status === 'completada') {
        await logDeploymentEvent(fastify, deploymentId, 'tarea_completada', `Tarea '${taskKey}' completada`, actorUserId, { taskKey });
    }

    return data;
}
