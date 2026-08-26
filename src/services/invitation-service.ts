import crypto from 'crypto';
import { supabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { sendOrganizationInvitationEmail } from './email.js';
import { clearPermissionsCache } from './permission-service.js';
import { hashToken } from '../lib/token-hash.js';
import type { OrganizationRole } from '../types/organization-roles.js';

export interface ServiceResult<T = undefined> {
    success: boolean;
    errorCode?: string;
    error?: string;
    data?: T;
}

interface RpcJsonResult<T> {
    success: boolean;
    error_code?: string;
    message?: string;
    data?: T;
}

/**
 * Construye el mensaje accionable de límite de asientos (FASE C, docs/tasks/
 * RBAC-permisos.md: "Devolver un mensaje accionable que indique el límite y
 * el plan que lo amplía"). Busca en `plans` el siguiente plan (por
 * `max_users` ascendente) que sí alcanzaría para un asiento más.
 */
async function buildSeatLimitMessage(organizationId: string, limit: number, used: number): Promise<string> {
    const base = `Límite de ${limit} usuarios alcanzado para el plan contratado (usados: ${used}, incluye invitaciones pendientes).`;

    const { data: org } = await supabaseAdmin.from('organizations').select('plan_key').eq('id', organizationId).maybeSingle();
    const { data: plans } = await supabaseAdmin.from('plans').select('key, name, max_users').order('max_users', { ascending: true });

    const currentPlanKey = org?.plan_key;
    const nextPlan = (plans ?? []).find((p) => p.key !== currentPlanKey && p.max_users > limit);

    if (nextPlan) {
        return `${base} El plan "${nextPlan.name}" permite hasta ${nextPlan.max_users} usuarios.`;
    }
    return base;
}

/**
 * POST /organizations/:id/invitations. El token crudo se genera aquí, se
 * hashea antes de persistir (create_invitation solo recibe el hash) y viaja
 * ÚNICAMENTE en el correo — nunca se incluye en el valor de retorno.
 */
export async function createInvitation(
    organizationId: string,
    email: string,
    role: OrganizationRole,
    invitedByUserId: string
): Promise<ServiceResult<{ id: string; email: string; role: string; expiresAt: string }>> {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);

    const { data, error } = await supabaseAdmin.rpc('create_invitation', {
        p_org_id: organizationId,
        p_email: email.trim().toLowerCase(),
        p_role: role,
        p_token_hash: tokenHash,
        p_invited_by: invitedByUserId,
    });

    if (error) {
        logger.error({ err: error, organizationId }, '[Invitations] Error inesperado en create_invitation');
        return { success: false, error: 'No se pudo crear la invitación.' };
    }

    const result = data as RpcJsonResult<{ id: string; email: string; role: string; expiresAt: string }>;
    if (!result.success) {
        if (result.error_code === 'SEAT_LIMIT') {
            const limit = (result.data as unknown as { limit: number; used: number } | undefined)?.limit ?? 0;
            const used = (result.data as unknown as { limit: number; used: number } | undefined)?.used ?? 0;
            return { success: false, errorCode: 'SEAT_LIMIT', error: await buildSeatLimitMessage(organizationId, limit, used) };
        }
        return { success: false, errorCode: result.error_code, error: result.message ?? 'No se pudo crear la invitación.' };
    }

    const { data: org } = await supabaseAdmin.from('organizations').select('name').eq('id', organizationId).maybeSingle();
    const frontendUrl = process.env.FRONTEND_APP_URL;
    const acceptUrl = frontendUrl ? `${frontendUrl}/invitations/accept?token=${token}` : null;

    try {
        await sendOrganizationInvitationEmail({
            to: result.data!.email,
            organizationName: org?.name ?? 'tu organización',
            role,
            acceptUrl,
        });
    } catch (err) {
        // La invitación ya quedó creada y auditada — un fallo de correo no
        // debe revertir eso (el admin puede reenviar el enlace a mano).
        logger.warn({ err, organizationId }, '[Invitations] No se pudo enviar el correo de invitación');
    }

    return { success: true, data: result.data };
}

export async function listPendingInvitations(organizationId: string) {
    const { data, error } = await supabaseAdmin
        .from('organization_invitations')
        .select('id, email, role, expires_at, invited_by, created_at')
        .eq('organization_id', organizationId)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .order('created_at', { ascending: false });

    if (error) {
        throw new Error(`Error al listar invitaciones pendientes: ${error.message}`);
    }
    return data ?? [];
}

export async function revokeInvitation(invitationId: string, actorId: string): Promise<ServiceResult> {
    const { data, error } = await supabaseAdmin.rpc('revoke_invitation', {
        p_invitation_id: invitationId,
        p_actor_id: actorId,
    });

    if (error) {
        logger.error({ err: error, invitationId }, '[Invitations] Error inesperado en revoke_invitation');
        return { success: false, error: 'No se pudo revocar la invitación.' };
    }

    const result = data as RpcJsonResult<undefined>;
    if (!result.success) {
        return { success: false, errorCode: result.error_code, error: result.message ?? 'No se pudo revocar la invitación.' };
    }
    return { success: true };
}

export async function acceptInvitation(
    token: string,
    acceptingUserId: string,
    acceptingEmail: string
): Promise<ServiceResult<{ organizationId: string; role: string }>> {
    const tokenHash = hashToken(token);

    const { data, error } = await supabaseAdmin.rpc('accept_invitation', {
        p_token_hash: tokenHash,
        p_accepting_user_id: acceptingUserId,
        p_accepting_email: acceptingEmail,
    });

    if (error) {
        logger.error({ err: error }, '[Invitations] Error inesperado en accept_invitation');
        return { success: false, error: 'No se pudo aceptar la invitación.' };
    }

    const result = data as RpcJsonResult<{ organizationId: string; role: string }>;
    if (!result.success) {
        return { success: false, errorCode: result.error_code, error: result.message ?? 'No se pudo aceptar la invitación.' };
    }

    if (result.data) {
        clearPermissionsCache(result.data.organizationId);
    }
    return { success: true, data: result.data };
}

export async function listOrganizationMembers(organizationId: string) {
    const { data, error } = await supabaseAdmin
        .from('organization_members')
        .select('user_id, role, created_at')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: true });

    if (error) {
        throw new Error(`Error al listar miembros: ${error.message}`);
    }
    return data ?? [];
}

export async function changeMemberRole(
    organizationId: string,
    memberUserId: string,
    newRole: OrganizationRole,
    actorId: string
): Promise<ServiceResult<{ userId: string; previousRole: string; newRole: string }>> {
    const { data, error } = await supabaseAdmin.rpc('change_member_role', {
        p_org_id: organizationId,
        p_member_user_id: memberUserId,
        p_new_role: newRole,
        p_actor_id: actorId,
    });

    if (error) {
        logger.error({ err: error, organizationId, memberUserId }, '[Invitations] Error inesperado en change_member_role');
        return { success: false, error: 'No se pudo cambiar el rol.' };
    }

    const result = data as RpcJsonResult<{ userId: string; previousRole: string; newRole: string }>;
    if (!result.success) {
        return { success: false, errorCode: result.error_code, error: result.message ?? 'No se pudo cambiar el rol.' };
    }

    clearPermissionsCache(organizationId, memberUserId);
    return { success: true, data: result.data };
}

export async function deactivateMember(organizationId: string, memberUserId: string, actorId: string): Promise<ServiceResult> {
    const { data, error } = await supabaseAdmin.rpc('deactivate_member', {
        p_org_id: organizationId,
        p_member_user_id: memberUserId,
        p_actor_id: actorId,
    });

    if (error) {
        logger.error({ err: error, organizationId, memberUserId }, '[Invitations] Error inesperado en deactivate_member');
        return { success: false, error: 'No se pudo desactivar al usuario.' };
    }

    const result = data as RpcJsonResult<undefined>;
    if (!result.success) {
        return { success: false, errorCode: result.error_code, error: result.message ?? 'No se pudo desactivar al usuario.' };
    }

    clearPermissionsCache(organizationId, memberUserId);
    return { success: true };
}

/**
 * Asientos usados/disponibles (FASE C: "Exponer asientos usados y
 * disponibles").
 */
export async function getSeatUsage(organizationId: string): Promise<{ used: number; limit: number }> {
    const { data: org } = await supabaseAdmin.from('organizations').select('plan_key').eq('id', organizationId).maybeSingle();
    const { data: plan } = await supabaseAdmin
        .from('plans')
        .select('max_users')
        .eq('key', org?.plan_key ?? 'starter')
        .maybeSingle();

    const { data: used, error } = await supabaseAdmin.rpc('organization_seats_used', { p_org_id: organizationId });
    if (error) {
        throw new Error(`Error al consultar asientos usados: ${error.message}`);
    }

    return { used: (used as number) ?? 0, limit: plan?.max_users ?? 2 };
}
