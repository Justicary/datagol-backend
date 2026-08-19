/**
 * Roles de negocio de `organization_members.role` consultados por
 * `has_permission()`/`auth_role_in_org()` (db/migrations/45_RBAC_permisos.sql).
 * Única fuente de verdad: ningún literal de rol debe escribirse en otro
 * lugar del código.
 *
 * A diferencia de `secret-keys.ts`, `organization_members.role` NO tiene un
 * CHECK constraint propio — la migración 45 solo restringe estos 4 valores
 * en `role_permissions`, `organization_role_permissions` y
 * `organization_invitations`. `organization_members` sigue aceptando el
 * valor `platform_admin` (usado por `src/lib/platform-admin.ts` para
 * identificar superadmins) a propósito; no es un rol de negocio de esta
 * tarea y por eso no aparece aquí.
 *
 * Verificado por inserción directa contra `role_permissions` (que sí tiene
 * el CHECK constraint compartido) — ver __tests__/organization-roles.test.ts.
 */
export const ORGANIZATION_ROLES = {
    OWNER: 'owner',
    ADMIN: 'admin',
    MEMBER: 'member',
    VIEWER: 'viewer',
} as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[keyof typeof ORGANIZATION_ROLES];

export const ALL_ORGANIZATION_ROLES: readonly OrganizationRole[] = Object.values(ORGANIZATION_ROLES);

/** Roles asignables por invitación — `organization_invitations.role` excluye `owner` (docs/tasks/RBAC-permisos.md, FASE C: "No se puede invitar como owner"). */
export const INVITABLE_ROLES: readonly OrganizationRole[] = [
    ORGANIZATION_ROLES.ADMIN,
    ORGANIZATION_ROLES.MEMBER,
    ORGANIZATION_ROLES.VIEWER,
];

export function isOrganizationRole(value: string): value is OrganizationRole {
    return (ALL_ORGANIZATION_ROLES as readonly string[]).includes(value);
}

export function isInvitableRole(value: string): value is OrganizationRole {
    return (INVITABLE_ROLES as readonly string[]).includes(value);
}
