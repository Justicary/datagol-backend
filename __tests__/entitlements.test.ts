import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { normalizePhoneE164 } from '../src/services/phone-normalization.js';
import {
    getOrganizationFeatures,
    setFeatureOverride,
    setOrganizationPlan,
    getFeatureAuditLog,
    clearEntitlementsCache,
    checkProviderCredentials,
} from '../src/services/entitlements.js';
import { getAuthorizedAgentTools } from '../src/services/agent-provisioning.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { entitlementsPlugin, requireFeature } from '../src/plugins/entitlements.js';
import supabasePlugin from '../src/plugins/supabase.js';
import * as secretService from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';

// Organización real existente en la base de datos con plan 'starter'
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';
// Organización ficticia que no existe en la base de datos
const FAKE_ORG_ID = '00000000-0000-0000-0000-000000000001';

describe('FASE 1 — Fundaciones & Entitlements', () => {
    beforeEach(async () => {
        // Asegurar que la org siempre inicia en plan starter y sin cache residual
        await supabaseAdmin.from('organizations').update({ plan_key: 'starter', max_concurrent_calls: 1 }).eq('id', REAL_ORG_ID);
        clearEntitlementsCache();
        vi.restoreAllMocks();
    });

    // ======================================================================
    // 1.3 — Normalización E.164
    // ======================================================================
    describe('1.3 — Normalización E.164', () => {
        it('debe normalizar números mexicanos sin código internacional a E.164', () => {
            const result = normalizePhoneE164('2221234567', 'MX');
            expect(result.success).toBe(true);
            expect(result.phoneE164).toBe('+522221234567');
        });

        it('debe manejar números inválidos devolviendo success: false sin lanzar excepción', () => {
            const result = normalizePhoneE164('123', 'MX');
            expect(result.success).toBe(false);
            expect(result.phoneE164).toBeNull();
            expect(result.error).toBeDefined();
        });
    });

    // ======================================================================
    // 1.6 — Pruebas de Entitlements & Control de Features
    // ======================================================================
    describe('1.6 — Pruebas de Entitlements & Control de Features', () => {

        // --- [D] Guarda de credenciales ---
        it('1.6.D — Habilitar feature sin credenciales del proveedor es rechazado', async () => {
            vi.spyOn(secretService, 'getSecret').mockResolvedValue(null);

            const result = await setFeatureOverride(
                REAL_ORG_ID,
                'whatsapp',
                true,
                'Prueba de habilitación sin credenciales'
            );
            expect(result.success).toBe(false);
            expect(result.error).toContain('Faltan las credenciales');
        });

        // --- [G] Caso inverso de [D]: con credenciales presentes, sí habilita ---
        it('1.6.G — Habilitar una feature CON las credenciales del proveedor presentes tiene éxito', async () => {
            const testFeature = 'whatsapp';

            vi.spyOn(secretService, 'getSecret').mockImplementation(async (_orgId, secretKey) => {
                if (secretKey === SECRET_KEYS.WHATSAPP_ACCESS_TOKEN) {
                    return 'test-whatsapp-access-token';
                }
                return null;
            });

            try {
                const result = await setFeatureOverride(
                    REAL_ORG_ID,
                    testFeature,
                    true,
                    'Prueba de habilitación con credenciales presentes'
                );

                expect(result.success).toBe(true);
                expect(result.error).toBeUndefined();

                const { data: override } = await supabaseAdmin
                    .from('organization_features')
                    .select('enabled')
                    .eq('organization_id', REAL_ORG_ID)
                    .eq('feature_key', testFeature)
                    .maybeSingle();
                expect(override?.enabled).toBe(true);
            } finally {
                await supabaseAdmin
                    .from('organization_features')
                    .delete()
                    .eq('organization_id', REAL_ORG_ID)
                    .eq('feature_key', testFeature);
                clearEntitlementsCache();
            }
        });

        // --- [F] Exclusión de herramientas ---
        it('1.6.F — El agente provisionado para un tenant sin call_transfer no expone esa herramienta', async () => {
            const tools = await getAuthorizedAgentTools(FAKE_ORG_ID);
            const hasCallTransfer = tools.some((t) => t.name === 'call_transfer');
            expect(hasCallTransfer).toBe(false);
        });

        // --- Reason vacío ---
        it('1.6.R — Rechaza modificar entitlement si el campo reason está vacío', async () => {
            const result = await setFeatureOverride(
                FAKE_ORG_ID,
                'telegram',
                true,
                '   '
            );
            expect(result.success).toBe(false);
            expect(result.error).toContain('reason');
        });

        // ==================================================================
        // [A] Tenant plan Starter → 403 en ruta protegida por requireFeature
        // ==================================================================
        it('1.6.A — Un tenant de plan Starter recibe 403 al invocar una ruta que requiere feature whatsapp', async () => {
            const app = Fastify({ logger: false });

            await app.register(supabasePlugin);
            await app.register(entitlementsPlugin);

            app.get(
                '/test/whatsapp-protected',
                { preHandler: [requireFeature('whatsapp')] },
                async (_request, reply) => {
                    return reply.send({ ok: true });
                }
            );

            await app.ready();

            try {
                const response = await app.inject({
                    method: 'GET',
                    url: '/test/whatsapp-protected',
                    headers: {
                        'x-organization-id': REAL_ORG_ID,
                    },
                });

                expect(response.statusCode).toBe(403);
                const body = response.json();
                expect(body.code).toBe('FEATURE_DISABLED');
                expect(body.requiredFeature).toBe('whatsapp');
            } finally {
                await app.close();
            }
        });

        // ==================================================================
        // [B] Override con expires_at vencido no concede acceso
        // ==================================================================
        it('1.6.B — Un override con expires_at vencido no concede acceso', async () => {
            const testFeature = 'telegram';
            const pastDate = '2020-01-01T00:00:00Z';

            await supabaseAdmin
                .from('organization_features')
                .upsert(
                    {
                        organization_id: REAL_ORG_ID,
                        feature_key: testFeature,
                        enabled: true,
                        reason: 'Test de expiración',
                        expires_at: pastDate,
                    },
                    { onConflict: 'organization_id,feature_key' }
                );

            clearEntitlementsCache();

            try {
                const features = await getOrganizationFeatures(REAL_ORG_ID);
                expect(features.has(testFeature)).toBe(false);
            } finally {
                await supabaseAdmin
                    .from('organization_features')
                    .delete()
                    .eq('organization_id', REAL_ORG_ID)
                    .eq('feature_key', testFeature);
            }
        });

        // ==================================================================
        // [C] Kill switch global gana sobre un override activo
        // ==================================================================
        it('1.6.C — El kill switch global gana sobre un override activo', async () => {
            const targetFeature = 'voice_inbound';

            const { data: originalFeature } = await supabaseAdmin
                .from('features')
                .select('globally_disabled')
                .eq('key', targetFeature)
                .maybeSingle();

            await supabaseAdmin
                .from('features')
                .update({ globally_disabled: true })
                .eq('key', targetFeature);

            await supabaseAdmin
                .from('organization_features')
                .upsert(
                    {
                        organization_id: REAL_ORG_ID,
                        feature_key: targetFeature,
                        enabled: true,
                        reason: 'Test de kill switch',
                    },
                    { onConflict: 'organization_id,feature_key' }
                );

            clearEntitlementsCache();

            try {
                const features = await getOrganizationFeatures(REAL_ORG_ID);
                expect(features.has(targetFeature)).toBe(false);
            } finally {
                await supabaseAdmin
                    .from('features')
                    .update({ globally_disabled: originalFeature?.globally_disabled ?? false })
                    .eq('key', targetFeature);

                await supabaseAdmin
                    .from('organization_features')
                    .delete()
                    .eq('organization_id', REAL_ORG_ID)
                    .eq('feature_key', targetFeature);

                clearEntitlementsCache();
            }
        });

        // ==================================================================
        // [E] Si la bitácora falla, el cambio se revierte
        // ==================================================================
        it('1.6.E — Si la escritura en feature_audit_log falla, el cambio de override se revierte', async () => {
            const testFeature = 'call_recording';
            const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

            let deleteCalledOnOverrides = false;

            vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                if (table === 'feature_audit_log') {
                    return {
                        insert: () => Promise.resolve({
                            data: null,
                            error: {
                                message: 'Simulated audit log failure',
                                code: '42P01',
                                details: null,
                                hint: null,
                            },
                        }),
                    } as any;
                }
                if (table === 'organization_features') {
                    const real = originalFrom(table);
                    const originalDelete = real.delete.bind(real);
                    return {
                        ...real,
                        upsert: real.upsert.bind(real),
                        delete: (...args: any[]) => {
                            deleteCalledOnOverrides = true;
                            return originalDelete(...args);
                        },
                    } as any;
                }
                return originalFrom(table);
            });

            try {
                const result = await setFeatureOverride(
                    REAL_ORG_ID,
                    testFeature,
                    false,
                    'Prueba de fallo de bitácora'
                );

                expect(result.success).toBe(false);
                expect(result.error).toContain('bitácora');
                expect(result.error).toContain('revertido');
                expect(deleteCalledOnOverrides).toBe(true);

                vi.restoreAllMocks();

                const { data: check } = await supabaseAdmin
                    .from('organization_features')
                    .select('feature_key')
                    .eq('organization_id', REAL_ORG_ID)
                    .eq('feature_key', testFeature)
                    .maybeSingle();

                expect(check).toBeNull();
            } finally {
                vi.restoreAllMocks();

                await supabaseAdmin
                    .from('organization_features')
                    .delete()
                    .eq('organization_id', REAL_ORG_ID)
                    .eq('feature_key', testFeature);
            }
        });

        // ==================================================================
        // Pruebas adicionales para matar mutantes en entitlements.ts
        // ==================================================================
        describe('Pruebas adicionales de mutation score para entitlements.ts', () => {
            it('getOrganizationFeatures devuelve un Set vacío cuando no se proporciona organizationId', async () => {
                const result = await getOrganizationFeatures('');
                expect(result.size).toBe(0);
            });

            it('checkProviderCredentials responde ok: true si la feature no existe o no requiere proveedor', async () => {
                const resNoFeature = await checkProviderCredentials(REAL_ORG_ID, 'feature_inexistente');
                expect(resNoFeature.ok).toBe(true);

                const resNoProvider = await checkProviderCredentials(REAL_ORG_ID, 'lead_capture');
                expect(resNoProvider.ok).toBe(true);
            });

            it('checkProviderCredentials responde ok: false si la credencial es nula, vacía o solo espacios', async () => {
                vi.spyOn(secretService, 'getSecret').mockResolvedValue('   ');
                const res = await checkProviderCredentials(REAL_ORG_ID, 'whatsapp'); // requires_provider = 'meta'
                expect(res.ok).toBe(false);
                expect(res.requiredProvider).toBe('meta');
                expect(res.missingSecret).toBe(SECRET_KEYS.WHATSAPP_ACCESS_TOKEN);

                vi.spyOn(secretService, 'getSecret').mockResolvedValue(null);
                const resNull = await checkProviderCredentials(REAL_ORG_ID, 'whatsapp');
                expect(resNull.ok).toBe(false);
            });

            it('checkProviderCredentials mapea correctamente todos los proveedores (elevenlabs, telnyx, cal, meta)', async () => {
                vi.spyOn(secretService, 'getSecret').mockResolvedValue('valid-secret-key');

                const resMeta = await checkProviderCredentials(REAL_ORG_ID, 'whatsapp');
                expect(resMeta.ok).toBe(true);

                const resCal = await checkProviderCredentials(REAL_ORG_ID, 'calendar_booking');
                expect(resCal.ok).toBe(true);
            });

            it('setFeatureOverride admite fecha de expiración opcional (expiresAt)', async () => {
                const futureDate = new Date(Date.now() + 86400000).toISOString();
                const res = await setFeatureOverride(
                    REAL_ORG_ID,
                    'call_recording',
                    false,
                    'Deshabilitar con expiración',
                    futureDate
                );

                expect(res.success).toBe(true);

                await supabaseAdmin
                    .from('organization_features')
                    .delete()
                    .eq('organization_id', REAL_ORG_ID)
                    .eq('feature_key', 'call_recording');
            });

            it('setOrganizationPlan rechaza razón vacía o nula', async () => {
                const res1 = await setOrganizationPlan(REAL_ORG_ID, 'pro', '');
                expect(res1.success).toBe(false);
                expect(res1.error).toContain('reason');

                const res2 = await setOrganizationPlan(REAL_ORG_ID, 'pro', '   ');
                expect(res2.success).toBe(false);
                expect(res2.error).toContain('reason');
            });

            it('setOrganizationPlan rechaza un plan no existente', async () => {
                const res = await setOrganizationPlan(REAL_ORG_ID, 'plan_inexistente_xyz', 'Upgrade');
                expect(res.success).toBe(false);
                expect(res.error).toContain('no existe');
            });

            it('setOrganizationPlan actualiza el plan y registra en auditoría exitosamente', async () => {
                try {
                    const res = await setOrganizationPlan(REAL_ORG_ID, 'pro', 'Cambio a plan Pro para pruebas unitarias');
                    expect(res.success).toBe(true);

                    const { data: updatedOrg } = await supabaseAdmin
                        .from('organizations')
                        .select('plan_key, max_concurrent_calls')
                        .eq('id', REAL_ORG_ID)
                        .single();

                    expect(updatedOrg?.plan_key).toBe('pro');
                    expect(updatedOrg?.max_concurrent_calls).toBeDefined();

                    const logs = await getFeatureAuditLog(REAL_ORG_ID);
                    expect(logs.length).toBeGreaterThan(0);
                    expect(logs[0].feature_key).toBe('plan:pro');
                    expect(logs[0].action).toBe('plan_changed');
                } finally {
                    await supabaseAdmin.from('organizations').update({ plan_key: 'starter', max_concurrent_calls: 1 }).eq('id', REAL_ORG_ID);
                    clearEntitlementsCache();
                }
            });

            it('setOrganizationPlan maneja fallos en update de la tabla organizations', async () => {
                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    if (table === 'organizations') {
                        return {
                            select: () => ({
                                eq: () => ({
                                    maybeSingle: () => Promise.resolve({ data: { key: 'pro', max_concurrent_calls: 5 }, error: null }),
                                }),
                            }),
                            update: () => ({
                                eq: () => Promise.resolve({ data: null, error: { message: 'Simulated DB update error' } }),
                            }),
                        } as any;
                    }
                    return originalFrom(table);
                });

                const res = await setOrganizationPlan(REAL_ORG_ID, 'pro', 'Prueba de error de DB');
                expect(res.success).toBe(false);
                expect(res.error).toContain('Error actualizando plan');
            });

            it('getFeatureAuditLog consulta la bitácora ordenando por fecha descendente', async () => {
                const logs = await getFeatureAuditLog(REAL_ORG_ID);
                expect(Array.isArray(logs)).toBe(true);
                if (logs.length >= 2) {
                    const time1 = new Date(logs[0].created_at).getTime();
                    const time2 = new Date(logs[1].created_at).getTime();
                    expect(time1).toBeGreaterThanOrEqual(time2);
                }
            });

            it('getFeatureAuditLog lanza excepción en caso de error en la consulta', async () => {
                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    if (table === 'feature_audit_log') {
                        return {
                            select: () => ({
                                eq: () => ({
                                    order: () => Promise.resolve({ data: null, error: { message: 'DB connection broken' } }),
                                }),
                            }),
                        } as any;
                    }
                    return originalFrom(table);
                });

                await expect(getFeatureAuditLog(REAL_ORG_ID)).rejects.toThrow('Error al consultar bitácora');
            });

            it('setFeatureOverride maneja fallos en upsert de la tabla organization_features', async () => {
                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    if (table === 'organization_features') {
                        return {
                            upsert: () => Promise.resolve({ data: null, error: { message: 'Simulated upsert error' } }),
                        } as any;
                    }
                    return originalFrom(table);
                });

                const res = await setFeatureOverride(REAL_ORG_ID, 'call_recording', false, 'Test error');
                expect(res.success).toBe(false);
                expect(res.error).toContain('Error guardando override');
            });

            it('setFeatureOverride captura excepciones al reprovisionar el agente sin fallar el override', async () => {
                const agentProv = await import('../src/services/agent-provisioning.js');
                vi.spyOn(agentProv, 'reprovisionAgent').mockRejectedValue(new Error('Provider API down'));

                const res = await setFeatureOverride(REAL_ORG_ID, 'call_recording', false, 'Test prov exception');
                expect(res.success).toBe(true);

                await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', 'call_recording');
            });

            it('setOrganizationPlan maneja errores en la inserción de la bitácora de auditoría sin revertir el cambio', async () => {
                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    if (table === 'feature_audit_log') {
                        return {
                            insert: () => Promise.resolve({ data: null, error: { message: 'Simulated audit log insert failure' } }),
                        } as any;
                    }
                    return originalFrom(table);
                });

                try {
                    const res = await setOrganizationPlan(REAL_ORG_ID, 'pro', 'Test audit error');
                    expect(res.success).toBe(true);
                } finally {
                    await supabaseAdmin.from('organizations').update({ plan_key: 'starter', max_concurrent_calls: 1 }).eq('id', REAL_ORG_ID);
                }
            });

            it('setOrganizationPlan captura excepciones al reprovisionar el agente tras un cambio de plan', async () => {
                const agentProv = await import('../src/services/agent-provisioning.js');
                vi.spyOn(agentProv, 'reprovisionAgent').mockRejectedValue(new Error('Provider API error'));

                try {
                    const res = await setOrganizationPlan(REAL_ORG_ID, 'pro', 'Test prov exception in plan');
                    expect(res.success).toBe(true);
                } finally {
                    await supabaseAdmin.from('organizations').update({ plan_key: 'starter', max_concurrent_calls: 1 }).eq('id', REAL_ORG_ID);
                }
            });

            it('clearEntitlementsCache limpia cache por org o globalmente', async () => {
                await getOrganizationFeatures(REAL_ORG_ID);
                clearEntitlementsCache(REAL_ORG_ID);
                clearEntitlementsCache();
            });

            it('ejercita el JS fallback de getOrganizationFeatures cuando el RPC falla o no devuelve array', async () => {
                const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'rpc').mockImplementation((fnName: string, ...args: any[]) => {
                    if (fnName === 'organization_enabled_features') {
                        return Promise.resolve({ data: null, error: { message: 'Simulated RPC failure' } }) as any;
                    }
                    return originalRpc(fnName, ...args);
                });

                // Insertar un override activo con expires_at en el futuro
                const futureDate = new Date(Date.now() + 86400000).toISOString();
                await supabaseAdmin.from('organization_features').upsert({
                    organization_id: REAL_ORG_ID,
                    feature_key: 'call_recording',
                    enabled: true,
                    reason: 'Test fallback JS',
                    expires_at: futureDate,
                }, { onConflict: 'organization_id,feature_key' });

                // Insertar un override explícitamente deshabilitado
                await supabaseAdmin.from('organization_features').upsert({
                    organization_id: REAL_ORG_ID,
                    feature_key: 'lead_capture',
                    enabled: false,
                    reason: 'Test disable fallback JS',
                }, { onConflict: 'organization_id,feature_key' });

                clearEntitlementsCache(REAL_ORG_ID);

                try {
                    const features = await getOrganizationFeatures(REAL_ORG_ID);
                    expect(features.has('call_recording')).toBe(true);
                    expect(features.has('lead_capture')).toBe(false);
                } finally {
                    await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', 'call_recording');
                    await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', 'lead_capture');
                    clearEntitlementsCache();
                }
            });
        });
    });
});
