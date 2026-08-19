import { z } from 'zod';
import { INVITABLE_ROLES, ALL_ORGANIZATION_ROLES } from '../types/organization-roles.js';

export const organizationIdParamsSchema = z.object({
    id: z.string().uuid(),
});

export const invitationParamsSchema = z.object({
    id: z.string().uuid(),
    invId: z.string().uuid(),
});

export const memberParamsSchema = z.object({
    id: z.string().uuid(),
    memberId: z.string().uuid(),
});

export const createInvitationBodySchema = z.object({
    email: z.string().email(),
    role: z.enum(INVITABLE_ROLES as unknown as readonly [string, ...string[]]),
});

export const acceptInvitationBodySchema = z.object({
    token: z.string().min(1),
});

export const changeMemberRoleBodySchema = z.object({
    role: z.enum(ALL_ORGANIZATION_ROLES as unknown as readonly [string, ...string[]]),
});
