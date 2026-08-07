import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setOrganizationStatus, listOrganizationsForAdmin } from '../src/services/organization-lifecycle.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { getFeatureAuditLog, clearEntitlementsCache } from '../src/services/entitlements.js';
import { logger } from '../src/lib/logger.js';

// Organización real existente (ver __tests__/entitlements.test.ts).
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

async function resetOrgStatus() {
    await supabaseAdmin
        .from('organizations')
        .update({ status: 'active', suspended_reason: null, suspended_at: null })
        .eq('id', REAL_ORG_ID);
    clearEntitlementsCache();
}

describe('services/organization-lifecycle.ts — setOrganizationStatus', () => {
    beforeEach(async () => {
        vi.restoreAllMocks();
        await resetOrgStatus();
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await resetOrgStatus();
    });

    it('rechaza reason vacío o solo espacios, sin escribir en la base', async () => {
        const res1 = await setOrganizationStatus(REAL_ORG_ID, 'suspended', '');
        expect(res1.success).toBe(false);
        expect(res1.error).toBe('El campo "reason" es obligatorio para cambiar el estado de la organización.');

        const res2 = await setOrganizationStatus(REAL_ORG_ID, 'suspended', '   ');
        expect(res2.success).toBe(false);
        expect(res2.error).toBe('El campo "reason" es obligatorio para cambiar el estado de la organización.');

        const { data: org } = await supabaseAdmin.from('organizations').select('status').eq('id', REAL_ORG_ID).single();
        expect(org?.status).toBe('active');
    });

    it('devuelve error si la organización no existe', async () => {
        const res = await setOrganizationStatus('00000000-0000-0000-0000-000000000001', 'suspended', 'Motivo cualquiera');
        expect(res.success).toBe(false);
        expect(res.error).toBe('La organización no existe.');
    });

    it('devuelve error si el UPDATE de la organización falla, sin llegar a auditar', async () => {
        const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
        const auditInsertSpy = vi.fn();
        vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
            if (table === 'organizations') {
                const real = originalFrom(table);
                return {
                    ...real,
                    select: real.select.bind(real),
                    update: () => ({
                        eq: () => Promise.resolve({ data: null, error: { message: 'Simulated update failure' } }),
                    }),
                } as any;
            }
            if (table === 'feature_audit_log') {
                return { insert: auditInsertSpy } as any;
            }
            return originalFrom(table);
        });

        const res = await setOrganizationStatus(REAL_ORG_ID, 'suspended', 'Prueba de fallo de UPDATE');
        expect(res.success).toBe(false);
        expect(res.error).toBe('Error actualizando el estado de la organización: Simulated update failure');
        expect(auditInsertSpy).not.toHaveBeenCalled();
    });

    it('suspende una organización activa: éxito, columnas correctas y fila en feature_audit_log con action=suspended', async () => {
        const res = await setOrganizationStatus(REAL_ORG_ID, 'suspended', 'Adeudo de facturación');
        expect(res.success).toBe(true);

        const { data: org } = await supabaseAdmin
            .from('organizations')
            .select('status, suspended_reason, suspended_at')
            .eq('id', REAL_ORG_ID)
            .single();
        expect(org?.status).toBe('suspended');
        expect(org?.suspended_reason).toBe('Adeudo de facturación');
        expect(org?.suspended_at).not.toBeNull();

        const logs = await getFeatureAuditLog(REAL_ORG_ID);
        const entry = logs.find((l: any) => l.feature_key === 'organization:status' && l.action === 'suspended');
        expect(entry).toBeDefined();
        expect(entry.reason).toBe('Adeudo de facturación');
        expect(entry.new_value).toBe(true);
        expect(entry.previous_value).toBe(false);
    });

    it('reactiva una organización suspendida: éxito, columnas limpias, action=reactivated', async () => {
        await setOrganizationStatus(REAL_ORG_ID, 'suspended', 'Suspensión previa para prueba');

        const res = await setOrganizationStatus(REAL_ORG_ID, 'active', 'Pago regularizado');
        expect(res.success).toBe(true);

        const { data: org } = await supabaseAdmin
            .from('organizations')
            .select('status, suspended_reason, suspended_at')
            .eq('id', REAL_ORG_ID)
            .single();
        expect(org?.status).toBe('active');
        expect(org?.suspended_reason).toBeNull();
        expect(org?.suspended_at).toBeNull();

        const logs = await getFeatureAuditLog(REAL_ORG_ID);
        const entry = logs.find((l: any) => l.feature_key === 'organization:status' && l.action === 'reactivated');
        expect(entry).toBeDefined();
        expect(entry.reason).toBe('Pago regularizado');
        expect(entry.new_value).toBe(false);
        expect(entry.previous_value).toBe(true);
    });

    it('suspender una organización ya suspendida falla con mensaje claro, sin lanzar excepción', async () => {
        await setOrganizationStatus(REAL_ORG_ID, 'suspended', 'Primera suspensión');

        const res = await setOrganizationStatus(REAL_ORG_ID, 'suspended', 'Segundo intento');
        expect(res.success).toBe(false);
        expect(res.error).toContain('ya está en estado');
    });

    it('reactivar una organización ya activa falla con mensaje claro, sin lanzar excepción', async () => {
        const res = await setOrganizationStatus(REAL_ORG_ID, 'active', 'Ya está activa');
        expect(res.success).toBe(false);
        expect(res.error).toContain('ya está en estado');
    });

    it('si falla el insert de auditoría, el UPDATE se revierte (mismo patrón que setFeatureOverride)', async () => {
        const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
        const revertUpdateArgs: unknown[] = [];
        const revertEqArgs: [unknown, unknown][] = [];
        vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
            if (table === 'feature_audit_log') {
                return {
                    insert: () => Promise.resolve({ data: null, error: { message: 'Simulated audit log failure' } }),
                } as any;
            }
            if (table === 'organizations') {
                const real = originalFrom(table);
                const originalUpdate = real.update.bind(real);
                return {
                    ...real,
                    select: real.select.bind(real),
                    update: (payload: unknown) => {
                        revertUpdateArgs.push(payload);
                        const builder = originalUpdate(payload);
                        const originalEq = builder.eq.bind(builder);
                        return {
                            ...builder,
                            eq: (col: unknown, val: unknown) => {
                                revertEqArgs.push([col, val]);
                                return originalEq(col, val);
                            },
                        };
                    },
                } as any;
            }
            return originalFrom(table);
        });

        const res = await setOrganizationStatus(REAL_ORG_ID, 'suspended', 'Prueba de fallo de bitácora');
        expect(res.success).toBe(false);
        expect(res.error).toContain('bitácora');
        expect(res.error).toContain('revertido');

        // Dos updates a 'organizations' se esperan: el UPDATE principal y el
        // revert. El revert (segundo) debe restaurar los valores previos
        // exactos y filtrar por el organizationId correcto — no por una
        // columna vacía, que dejaría la fila suspendida sin revertir.
        expect(revertUpdateArgs.length).toBe(2);
        expect(revertUpdateArgs[1]).toEqual({ status: 'active', suspended_reason: null, suspended_at: null });
        expect(revertEqArgs[1]).toEqual(['id', REAL_ORG_ID]);

        vi.restoreAllMocks();

        const { data: org } = await supabaseAdmin.from('organizations').select('status, suspended_reason, suspended_at').eq('id', REAL_ORG_ID).single();
        expect(org?.status).toBe('active');
        expect(org?.suspended_reason).toBeNull();
        expect(org?.suspended_at).toBeNull();
    });
});

describe('services/organization-lifecycle.ts — listOrganizationsForAdmin', () => {
    afterEach(async () => {
        await supabaseAdmin.from('organizations').update({ webhook_token: null }).eq('id', REAL_ORG_ID);
    });

    it('nunca incluye webhook_token crudo, solo webhook_token_present', async () => {
        await supabaseAdmin.from('organizations').update({ webhook_token: `lifecycle-test-token-${Date.now()}` }).eq('id', REAL_ORG_ID);

        const orgs = await listOrganizationsForAdmin();
        const org = orgs.find((o) => o.id === REAL_ORG_ID);
        expect(org).toBeDefined();
        expect(org).not.toHaveProperty('webhook_token');
        expect(org?.webhook_token_present).toBe(true);
        expect(JSON.stringify(org)).not.toContain('lifecycle-test-token');
    });

    it('webhook_token_present es false cuando la organización no tiene token', async () => {
        await supabaseAdmin.from('organizations').update({ webhook_token: null }).eq('id', REAL_ORG_ID);

        const orgs = await listOrganizationsForAdmin();
        const org = orgs.find((o) => o.id === REAL_ORG_ID);
        expect(org?.webhook_token_present).toBe(false);
    });

    it('lanza excepción con el mensaje exacto si la consulta a organizations falla, y lo registra con logger.error', async () => {
        const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
        const queryError = { message: 'Simulated organizations query failure' };
        vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
            if (table === 'organizations') {
                return {
                    select: () => ({
                        order: () => Promise.resolve({ data: null, error: queryError }),
                    }),
                } as any;
            }
            return originalFrom(table);
        });
        const errorSpy = vi.spyOn(logger, 'error');

        await expect(listOrganizationsForAdmin()).rejects.toThrow('Error al listar organizaciones: Simulated organizations query failure');
        expect(errorSpy).toHaveBeenCalledWith(
            { err: queryError },
            '[OrganizationLifecycle] Error al listar organizaciones para admin'
        );

        vi.restoreAllMocks();
    });

    it('devuelve [] (no lanza) cuando data llega null sin error', async () => {
        const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
        vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
            if (table === 'organizations') {
                return {
                    select: () => ({
                        order: () => Promise.resolve({ data: null, error: null }),
                    }),
                } as any;
            }
            return originalFrom(table);
        });

        const orgs = await listOrganizationsForAdmin();
        expect(orgs).toEqual([]);
        vi.restoreAllMocks();
    });
});
