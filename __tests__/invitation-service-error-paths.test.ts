import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { logger } from '../src/lib/logger.js';
import * as emailService from '../src/services/email.js';
import {
    createInvitation,
    revokeInvitation,
    acceptInvitation,
    changeMemberRole,
    deactivateMember,
    listPendingInvitations,
    listOrganizationMembers,
    getSeatUsage,
} from '../src/services/invitation-service.js';
import { ORGANIZATION_ROLES } from '../src/types/organization-roles.js';

/**
 * Cobertura de las ramas de error de bajo nivel de invitation-service.ts
 * (fallo de red/DB en el RPC, no un {success:false} de negocio) — mockeando
 * supabaseAdmin, mismo patrón que __tests__/entitlements.test.ts. También
 * cubre ramas de rechazo de negocio y defensivas (`?? []`) que las pruebas
 * de integración de organization-members.test.ts no garantizan atribuir
 * correctamente en el análisis de cobertura de Stryker por ir a través de
 * la cadena completa ruta→servicio→RPC real.
 */
describe('services/invitation-service.ts — ramas de error inesperado, rechazo de negocio y defensivas', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('createInvitation', () => {
        it('si el RPC falla a nivel de red/DB, registra el error y devuelve mensaje genérico sin lanzar', async () => {
            const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({ data: null, error: { message: 'Simulated network error' } } as any);

            const result = await createInvitation('org-1', 'x@example.invalid', ORGANIZATION_ROLES.MEMBER, 'actor-1');

            expect(result.success).toBe(false);
            expect(result.error).toBe('No se pudo crear la invitación.');
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ err: expect.anything(), organizationId: 'org-1' }),
                '[Invitations] Error inesperado en create_invitation'
            );
        });

        it('rechazo de negocio distinto de SEAT_LIMIT (ej. OWNER_INVITE_FORBIDDEN) propaga error_code y message tal cual', async () => {
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({
                data: { success: false, error_code: 'OWNER_INVITE_FORBIDDEN', message: 'No se puede invitar como owner.' },
                error: null,
            } as any);

            const result = await createInvitation('org-1', 'x@example.invalid', ORGANIZATION_ROLES.MEMBER, 'actor-1');

            expect(result.success).toBe(false);
            expect(result.errorCode).toBe('OWNER_INVITE_FORBIDDEN');
            expect(result.error).toBe('No se puede invitar como owner.');
        });

        it('rechazo de negocio sin "message" del RPC cae al mensaje genérico', async () => {
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({
                data: { success: false, error_code: 'ALGO_RARO' },
                error: null,
            } as any);

            const result = await createInvitation('org-1', 'x@example.invalid', ORGANIZATION_ROLES.MEMBER, 'actor-1');

            expect(result.error).toBe('No se pudo crear la invitación.');
        });

        it('SEAT_LIMIT sin "data" en la respuesta del RPC usa límite/usados en 0 (no revienta)', async () => {
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({
                data: { success: false, error_code: 'SEAT_LIMIT' }, // sin "data"
                error: null,
            } as any);

            const result = await createInvitation(crypto.randomUUID(), 'x@example.invalid', ORGANIZATION_ROLES.MEMBER, 'actor-1');

            expect(result.success).toBe(false);
            expect(result.errorCode).toBe('SEAT_LIMIT');
            expect(result.error).toContain('Límite de 0 usuarios');
        });

        it('SEAT_LIMIT con "data" del RPC usa el límite/usados reales en el mensaje', async () => {
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({
                data: { success: false, error_code: 'SEAT_LIMIT', data: { limit: 5, used: 5 } },
                error: null,
            } as any);

            const result = await createInvitation(crypto.randomUUID(), 'x@example.invalid', ORGANIZATION_ROLES.MEMBER, 'actor-1');

            expect(result.error).toContain('Límite de 5 usuarios');
        });

        it('éxito: si no se encuentra el nombre de la organización, el correo usa "tu organización" por defecto', async () => {
            const emailSpy = vi.spyOn(emailService, 'sendOrganizationInvitationEmail').mockResolvedValue(null as any);
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({
                data: { success: true, data: { id: 'inv-1', email: 'x@example.invalid', role: 'member', expiresAt: '2026-01-01' } },
                error: null,
            } as any);
            const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
            vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                if (table === 'organizations') {
                    return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) } as any;
                }
                return originalFrom(table);
            });

            const result = await createInvitation('org-inexistente', 'x@example.invalid', ORGANIZATION_ROLES.MEMBER, 'actor-1');

            expect(result.success).toBe(true);
            expect(emailSpy).toHaveBeenCalledWith(expect.objectContaining({ organizationName: 'tu organización' }));
        });

        it('éxito: con FRONTEND_APP_URL configurada, el correo incluye el enlace de aceptación con el token', async () => {
            const original = process.env.FRONTEND_APP_URL;
            process.env.FRONTEND_APP_URL = 'https://app.datagol.net';
            try {
                const emailSpy = vi.spyOn(emailService, 'sendOrganizationInvitationEmail').mockResolvedValue(null as any);
                vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({
                    data: { success: true, data: { id: 'inv-1', email: 'x@example.invalid', role: 'member', expiresAt: '2026-01-01' } },
                    error: null,
                } as any);

                await createInvitation(crypto.randomUUID(), 'x@example.invalid', ORGANIZATION_ROLES.MEMBER, 'actor-1');

                expect(emailSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ acceptUrl: expect.stringMatching(/^https:\/\/app\.datagol\.net\/invitations\/accept\?token=/) })
                );
            } finally {
                process.env.FRONTEND_APP_URL = original;
            }
        });

        it('éxito: si el envío del correo falla, la invitación sigue siendo exitosa (no se revierte) y se registra una advertencia', async () => {
            const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
            vi.spyOn(emailService, 'sendOrganizationInvitationEmail').mockRejectedValue(new Error('Resend down'));
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({
                data: { success: true, data: { id: 'inv-1', email: 'x@example.invalid', role: 'member', expiresAt: '2026-01-01' } },
                error: null,
            } as any);

            const result = await createInvitation('org-1', 'x@example.invalid', ORGANIZATION_ROLES.MEMBER, 'actor-1');

            expect(result.success).toBe(true);
            expect(warnSpy).toHaveBeenCalledWith(
                expect.objectContaining({ err: expect.anything(), organizationId: 'org-1' }),
                '[Invitations] No se pudo enviar el correo de invitación'
            );
        });
    });

    it('buildSeatLimitMessage (vía SEAT_LIMIT real): sin un plan siguiente con más cupo, omite la sugerencia de plan', async () => {
        // El plan 'enterprise' (999 asientos) es el de mayor cupo — pedir un
        // límite mayor o igual a 999 no encuentra "próximo plan".
        vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({
            data: { success: false, error_code: 'SEAT_LIMIT', data: { limit: 999, used: 999 } },
            error: null,
        } as any);

        const result = await createInvitation(crypto.randomUUID(), 'x@example.invalid', ORGANIZATION_ROLES.MEMBER, 'actor-1');

        expect(result.error).toContain('Límite de 999 usuarios');
        expect(result.error).not.toContain('permite hasta');
    });

    describe('revokeInvitation', () => {
        it('si el RPC falla a nivel de red/DB, registra el error y devuelve mensaje genérico', async () => {
            const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({ data: null, error: { message: 'Simulated network error' } } as any);

            const result = await revokeInvitation('inv-1', 'actor-1');

            expect(result.success).toBe(false);
            expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ err: expect.anything(), invitationId: 'inv-1' }), expect.any(String));
        });

        it('rechazo de negocio (ej. NOT_FOUND) propaga error_code y message', async () => {
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({
                data: { success: false, error_code: 'NOT_FOUND', message: 'Invitación no encontrada.' },
                error: null,
            } as any);
            const result = await revokeInvitation('inv-1', 'actor-1');
            expect(result.errorCode).toBe('NOT_FOUND');
            expect(result.error).toBe('Invitación no encontrada.');
        });
    });

    describe('acceptInvitation', () => {
        it('si el RPC falla a nivel de red/DB, registra el error y devuelve mensaje genérico', async () => {
            const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({ data: null, error: { message: 'Simulated network error' } } as any);

            const result = await acceptInvitation('token-x', 'user-1', 'x@example.invalid');

            expect(result.success).toBe(false);
            expect(errorSpy).toHaveBeenCalled();
        });

        it('rechazo de negocio (ej. INVALID_TOKEN) propaga error_code y message', async () => {
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({
                data: { success: false, error_code: 'INVALID_TOKEN', message: 'Token inválido.' },
                error: null,
            } as any);
            const result = await acceptInvitation('token-x', 'user-1', 'x@example.invalid');
            expect(result.errorCode).toBe('INVALID_TOKEN');
            expect(result.error).toBe('Token inválido.');
        });
    });

    describe('changeMemberRole', () => {
        it('si el RPC falla a nivel de red/DB, registra el error y devuelve mensaje genérico', async () => {
            const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({ data: null, error: { message: 'Simulated network error' } } as any);

            const result = await changeMemberRole('org-1', 'user-1', ORGANIZATION_ROLES.ADMIN, 'actor-1');

            expect(result.success).toBe(false);
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ err: expect.anything(), organizationId: 'org-1', memberUserId: 'user-1' }),
                expect.any(String)
            );
        });

        it('rechazo de negocio (ej. LAST_OWNER) propaga error_code y message', async () => {
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({
                data: { success: false, error_code: 'LAST_OWNER', message: 'No se puede degradar al último owner.' },
                error: null,
            } as any);
            const result = await changeMemberRole('org-1', 'user-1', ORGANIZATION_ROLES.MEMBER, 'actor-1');
            expect(result.errorCode).toBe('LAST_OWNER');
        });
    });

    describe('deactivateMember', () => {
        it('si el RPC falla a nivel de red/DB, registra el error y devuelve mensaje genérico', async () => {
            const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({ data: null, error: { message: 'Simulated network error' } } as any);

            const result = await deactivateMember('org-1', 'user-1', 'actor-1');

            expect(result.success).toBe(false);
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ err: expect.anything(), organizationId: 'org-1', memberUserId: 'user-1' }),
                expect.any(String)
            );
        });

        it('rechazo de negocio (ej. CANNOT_REMOVE_SELF) propaga error_code y message', async () => {
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({
                data: { success: false, error_code: 'CANNOT_REMOVE_SELF', message: 'No puedes desactivarte a ti mismo.' },
                error: null,
            } as any);
            const result = await deactivateMember('org-1', 'user-1', 'user-1');
            expect(result.errorCode).toBe('CANNOT_REMOVE_SELF');
        });
    });

    describe('listPendingInvitations / listOrganizationMembers — defensiva "?? []"', () => {
        it('listPendingInvitations: si la consulta falla, lanza con mensaje descriptivo', async () => {
            const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
            vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                if (table === 'organization_invitations') {
                    return {
                        select: () => ({
                            eq: () => ({ is: () => ({ is: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'Simulated query error' } }) }) }) }),
                        }),
                    } as any;
                }
                return originalFrom(table);
            });
            await expect(listPendingInvitations('org-1')).rejects.toThrow('Error al listar invitaciones pendientes');
        });

        it('listPendingInvitations: éxito con data null (sin error) devuelve arreglo vacío, no null', async () => {
            const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
            vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                if (table === 'organization_invitations') {
                    return {
                        select: () => ({
                            eq: () => ({ is: () => ({ is: () => ({ order: () => Promise.resolve({ data: null, error: null }) }) }) }),
                        }),
                    } as any;
                }
                return originalFrom(table);
            });
            const result = await listPendingInvitations('org-1');
            expect(result).toEqual([]);
        });

        it('listOrganizationMembers: si la consulta falla, lanza con mensaje descriptivo', async () => {
            const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
            vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                if (table === 'organization_members') {
                    return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'Simulated query error' } }) }) }) } as any;
                }
                return originalFrom(table);
            });
            await expect(listOrganizationMembers('org-1')).rejects.toThrow('Error al listar miembros');
        });

        it('listOrganizationMembers: éxito con data null (sin error) devuelve arreglo vacío, no null', async () => {
            const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
            vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                if (table === 'organization_members') {
                    return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: null }) }) }) } as any;
                }
                return originalFrom(table);
            });
            const result = await listOrganizationMembers('org-1');
            expect(result).toEqual([]);
        });
    });

    describe('getSeatUsage', () => {
        it('si organization_seats_used falla, lanza con mensaje descriptivo', async () => {
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({ data: null, error: { message: 'Simulated RPC error' } } as any);
            await expect(getSeatUsage('org-1')).rejects.toThrow('Error al consultar asientos usados');
        });

        it('sin fila de plan (org/plan no encontrados), usa el límite por defecto de 2', async () => {
            const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
            vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                if (table === 'organizations') {
                    return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) } as any;
                }
                if (table === 'plans') {
                    return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) } as any;
                }
                return originalFrom(table);
            });
            vi.spyOn(supabaseAdmin, 'rpc').mockResolvedValue({ data: 0, error: null } as any);

            const usage = await getSeatUsage('org-inexistente');
            expect(usage.limit).toBe(2);
            expect(usage.used).toBe(0);
        });
    });
});
