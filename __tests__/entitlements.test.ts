import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { normalizePhoneE164 } from '../src/services/phone-normalization.js';
import {
    getOrganizationFeatures,
    isFeatureEnabled,
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
import * as llmConfigService from '../src/services/llm-config-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { logger } from '../src/lib/logger.js';

/**
 * Envuelve un query builder de Supabase en un Proxy que registra los
 * argumentos de `.select()` y `.eq()` sin alterar el comportamiento real —
 * necesario para distinguir mutantes de mutación (columnas/valores vaciados)
 * que, contra datos reales, producirían el mismo resultado observable por
 * casualidad (p.ej. PostgREST puede devolver todas las columnas cuando el
 * `select` llega vacío).
 */
function traceQueryArgs(builder: any, selectSink: unknown[], eqSink: [unknown, unknown][]): any {
    return new Proxy(builder, {
        get(target, prop, receiver) {
            const orig = Reflect.get(target, prop, receiver);
            if (typeof orig !== 'function') return orig;
            if (prop === 'select') {
                return (...args: any[]) => {
                    selectSink.push(args[0]);
                    return traceQueryArgs(orig.apply(target, args), selectSink, eqSink);
                };
            }
            if (prop === 'eq') {
                return (...args: any[]) => {
                    eqSink.push([args[0], args[1]]);
                    return traceQueryArgs(orig.apply(target, args), selectSink, eqSink);
                };
            }
            return orig.bind(target);
        },
    });
}

// Organización real existente en la base de datos con plan 'starter'
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';
// Organización ficticia que no existe en la base de datos
const FAKE_ORG_ID = '00000000-0000-0000-0000-000000000001';

describe('FASE 1 — Fundaciones & Entitlements', () => {
    beforeEach(async () => {
        vi.restoreAllMocks();
        // Asegurar que la org siempre inicia en plan starter, sin overrides residuales ni cache
        await supabaseAdmin.from('organizations').update({ plan_key: 'starter', max_concurrent_calls: 1 }).eq('id', REAL_ORG_ID);
        await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', 'whatsapp');
        await supabaseAdmin.from('plan_features').delete().eq('plan_key', 'starter').eq('feature_key', 'whatsapp');
        clearEntitlementsCache();
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

        // --- Guarda de LLM BYOK validado para features con requires_provider
        // NULL (docs/tasks/reportes-semanales.md, B.5/C.5) ---
        describe('Guarda de isLlmConfigValidated (weekly_planning_report / weekly_executive_report / competitor_analysis)', () => {
            it.each(['weekly_planning_report', 'weekly_executive_report', 'competitor_analysis'])(
                'habilitar "%s" sin llave de LLM validada es rechazado, sin importar checkProviderCredentials (requires_provider es NULL)',
                async (featureKey) => {
                    vi.spyOn(llmConfigService, 'isLlmConfigValidated').mockResolvedValue(false);

                    const result = await setFeatureOverride(REAL_ORG_ID, featureKey, true, 'Prueba de guarda de LLM sin validar');

                    expect(result.success).toBe(false);
                    expect(result.error).toContain('llave de LLM');
                }
            );

            it.each(['weekly_planning_report', 'weekly_executive_report', 'competitor_analysis'])(
                'contraparte de éxito: habilitar "%s" con llave de LLM validada tiene éxito',
                async (featureKey) => {
                    vi.spyOn(llmConfigService, 'isLlmConfigValidated').mockResolvedValue(true);

                    try {
                        const result = await setFeatureOverride(REAL_ORG_ID, featureKey, true, 'Prueba de guarda de LLM validada');
                        expect(result.success).toBe(true);
                    } finally {
                        await supabaseAdmin
                            .from('organization_features')
                            .delete()
                            .eq('organization_id', REAL_ORG_ID)
                            .eq('feature_key', featureKey);
                        clearEntitlementsCache();
                    }
                }
            );

            it('no aplica la guarda de LLM a una feature que no está en la lista especial (ej. "whatsapp")', async () => {
                const isLlmConfigValidatedSpy = vi.spyOn(llmConfigService, 'isLlmConfigValidated');
                vi.spyOn(secretService, 'getSecret').mockImplementation(async (_orgId, secretKey) => {
                    if (secretKey === SECRET_KEYS.WHATSAPP_ACCESS_TOKEN) return 'test-token';
                    return null;
                });

                try {
                    const result = await setFeatureOverride(REAL_ORG_ID, 'whatsapp', true, 'Prueba de no-aplicación de guarda de LLM');
                    expect(result.success).toBe(true);
                    expect(isLlmConfigValidatedSpy).not.toHaveBeenCalled();
                } finally {
                    await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', 'whatsapp');
                    clearEntitlementsCache();
                }
            });
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

            it('getFeatureAuditLog devuelve [] (no undefined/null) cuando data llega null sin error', async () => {
                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    if (table === 'feature_audit_log') {
                        return {
                            select: () => ({
                                eq: () => ({
                                    order: () => Promise.resolve({ data: null, error: null }),
                                }),
                            }),
                        } as any;
                    }
                    return originalFrom(table);
                });

                const logs = await getFeatureAuditLog(REAL_ORG_ID);
                expect(logs).toEqual([]);

                vi.restoreAllMocks();
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

            it('isFeatureEnabled delega en getOrganizationFeatures y verifica membership real', async () => {
                // 'calendar_booking' está en el plan starter con enabled:true
                // (verificado contra plan_features real — a diferencia de
                // 'lead_capture', que el plan starter tiene con enabled:false).
                expect(await isFeatureEnabled(REAL_ORG_ID, 'calendar_booking')).toBe(true);
                expect(await isFeatureEnabled(REAL_ORG_ID, 'feature_inexistente_xyz')).toBe(false);
            });

            it('getOrganizationFeatures responde desde caché en una segunda llamada inmediata (no vuelve a llamar al RPC)', async () => {
                const rpcSpy = vi.spyOn(supabaseAdmin, 'rpc').mockImplementation((fnName: string) => {
                    if (fnName === 'organization_enabled_features') {
                        return Promise.resolve({ data: ['lead_capture'], error: null }) as any;
                    }
                    return Promise.resolve({ data: null, error: null }) as any;
                });

                clearEntitlementsCache(REAL_ORG_ID);
                await getOrganizationFeatures(REAL_ORG_ID);
                await getOrganizationFeatures(REAL_ORG_ID);

                expect(rpcSpy).toHaveBeenCalledTimes(1);
            });

            it('getOrganizationFeatures vuelve a consultar tras expirar el TTL de caché de 30s', async () => {
                const rpcSpy = vi.spyOn(supabaseAdmin, 'rpc').mockImplementation((fnName: string) => {
                    if (fnName === 'organization_enabled_features') {
                        return Promise.resolve({ data: ['lead_capture'], error: null }) as any;
                    }
                    return Promise.resolve({ data: null, error: null }) as any;
                });
                const dateSpy = vi.spyOn(Date, 'now');
                const T0 = 1_700_000_000_000;

                clearEntitlementsCache(REAL_ORG_ID);
                dateSpy.mockReturnValueOnce(T0);
                await getOrganizationFeatures(REAL_ORG_ID);

                dateSpy.mockReturnValueOnce(T0 + 30_001);
                await getOrganizationFeatures(REAL_ORG_ID);

                expect(rpcSpy).toHaveBeenCalledTimes(2);
                dateSpy.mockRestore();
            });

            it('el límite del TTL es estrictamente "expiresAt > now": exactamente a los 30000ms ya se considera expirado', async () => {
                const rpcSpy = vi.spyOn(supabaseAdmin, 'rpc').mockImplementation((fnName: string) => {
                    if (fnName === 'organization_enabled_features') {
                        return Promise.resolve({ data: ['lead_capture'], error: null }) as any;
                    }
                    return Promise.resolve({ data: null, error: null }) as any;
                });
                const dateSpy = vi.spyOn(Date, 'now');
                const T0 = 1_700_000_000_000;

                clearEntitlementsCache(REAL_ORG_ID);
                dateSpy.mockReturnValueOnce(T0);
                await getOrganizationFeatures(REAL_ORG_ID);

                // Exactamente el TTL (30_000ms) después: debe tratarse como
                // expirado (">" estricto), no como válido todavía (que sería ">=").
                dateSpy.mockReturnValueOnce(T0 + 30_000);
                await getOrganizationFeatures(REAL_ORG_ID);

                expect(rpcSpy).toHaveBeenCalledTimes(2);
                dateSpy.mockRestore();
            });

            it('getOrganizationFeatures respeta el kill switch global (globally_disabled) también en el fallback JS cuando el RPC falla', async () => {
                const targetFeature = 'voice_outbound';
                const { data: originalFeature } = await supabaseAdmin
                    .from('features')
                    .select('globally_disabled')
                    .eq('key', targetFeature)
                    .maybeSingle();

                const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'rpc').mockImplementation((fnName: string, ...args: any[]) => {
                    if (fnName === 'organization_enabled_features') {
                        return Promise.resolve({ data: null, error: { message: 'Simulated RPC failure' } }) as any;
                    }
                    return originalRpc(fnName, ...args);
                });

                await supabaseAdmin.from('features').update({ globally_disabled: true }).eq('key', targetFeature);
                await supabaseAdmin.from('organization_features').upsert(
                    {
                        organization_id: REAL_ORG_ID,
                        feature_key: targetFeature,
                        enabled: true,
                        reason: 'Test kill switch en fallback JS',
                    },
                    { onConflict: 'organization_id,feature_key' }
                );

                clearEntitlementsCache(REAL_ORG_ID);

                try {
                    const features = await getOrganizationFeatures(REAL_ORG_ID);
                    // Aunque el override lo habilita explícitamente, el kill
                    // switch global debe ganar (AGENTS.md §16).
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
                    vi.restoreAllMocks();
                    clearEntitlementsCache();
                }
            });

            it('el fallback JS: un override enabled:true SÍ agrega una feature que no viene del plan (rama "if" real, no solo la del plan)', async () => {
                // 'call_transfer' no está en plan_features de 'starter' y no está
                // deshabilitado globalmente — si apareciera en el resultado,
                // solo puede ser por el override.
                const targetFeature = 'call_transfer';
                const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'rpc').mockImplementation((fnName: string, ...args: any[]) => {
                    if (fnName === 'organization_enabled_features') {
                        return Promise.resolve({ data: null, error: { message: 'Simulated RPC failure' } }) as any;
                    }
                    return originalRpc(fnName, ...args);
                });

                await supabaseAdmin.from('organization_features').upsert(
                    {
                        organization_id: REAL_ORG_ID,
                        feature_key: targetFeature,
                        enabled: true,
                        reason: 'Test rama add del fallback JS',
                    },
                    { onConflict: 'organization_id,feature_key' }
                );

                clearEntitlementsCache(REAL_ORG_ID);

                try {
                    const features = await getOrganizationFeatures(REAL_ORG_ID);
                    expect(features.has(targetFeature)).toBe(true);
                } finally {
                    await supabaseAdmin
                        .from('organization_features')
                        .delete()
                        .eq('organization_id', REAL_ORG_ID)
                        .eq('feature_key', targetFeature);
                    vi.restoreAllMocks();
                    clearEntitlementsCache();
                }
            });

            it('el fallback JS resuelve planKey a "starter" cuando la organización no existe, y consulta las columnas/valores exactos esperados', async () => {
                const orgSelectArgs: unknown[] = [];
                const orgEqArgs: [unknown, unknown][] = [];
                const pfSelectArgs: unknown[] = [];
                const pfEqArgs: [unknown, unknown][] = [];

                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    const real = originalFrom(table);
                    if (table === 'organizations') return traceQueryArgs(real, orgSelectArgs, orgEqArgs);
                    if (table === 'plan_features') return traceQueryArgs(real, pfSelectArgs, pfEqArgs);
                    return real;
                });

                const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'rpc').mockImplementation((fnName: string, ...args: any[]) => {
                    if (fnName === 'organization_enabled_features') {
                        return Promise.resolve({ data: null, error: { message: 'Simulated RPC failure' } }) as any;
                    }
                    return originalRpc(fnName, ...args);
                });

                clearEntitlementsCache(FAKE_ORG_ID);
                const features = await getOrganizationFeatures(FAKE_ORG_ID);

                // 'calendar_booking' solo puede haber llegado vía el plan
                // 'starter' por defecto (enabled:true ahí) — FAKE_ORG_ID no
                // existe, así que org?.plan_key es undefined y debe caer al
                // default.
                expect(features.has('calendar_booking')).toBe(true);
                expect(orgSelectArgs).toContain('plan_key');
                expect(orgEqArgs).toContainEqual(['id', FAKE_ORG_ID]);
                expect(pfSelectArgs).toContain('feature_key');
                expect(pfEqArgs).toContainEqual(['plan_key', 'starter']);

                vi.restoreAllMocks();
                clearEntitlementsCache();
            });

            it('cuando el RPC organization_enabled_features tiene éxito, usa exactamente su resultado y no continúa hacia el fallback JS', async () => {
                const sentinelFeature = 'una_feature_solo_del_rpc_xyz';
                const rpcSpy = vi.spyOn(supabaseAdmin, 'rpc').mockImplementation((fnName: string) => {
                    if (fnName === 'organization_enabled_features') {
                        return Promise.resolve({ data: [sentinelFeature], error: null }) as any;
                    }
                    return Promise.resolve({ data: null, error: null }) as any;
                });

                clearEntitlementsCache(REAL_ORG_ID);
                const features = await getOrganizationFeatures(REAL_ORG_ID);

                // Si el bloque del camino RPC-éxito se vaciara, la ejecución
                // caería al fallback (plan_features/overrides reales), que
                // JAMÁS podría contener esta clave inventada.
                expect(features.has(sentinelFeature)).toBe(true);

                rpcSpy.mockRestore();
                clearEntitlementsCache();
            });

            it('getOrganizationFeatures no lanza excepción si la consulta a features (kill switch) falla (if(globalFeatures) real, no siempre-verdadero)', async () => {
                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    if (table === 'features') {
                        return {
                            select: () => Promise.resolve({ data: null, error: { message: 'Simulated features query failure' } }),
                        } as any;
                    }
                    return originalFrom(table);
                });

                clearEntitlementsCache(REAL_ORG_ID);
                const features = await getOrganizationFeatures(REAL_ORG_ID);
                expect(features instanceof Set).toBe(true);

                vi.restoreAllMocks();
                clearEntitlementsCache();
            });

            it('el fallback JS responde a un error de plan_features sin lanzar excepción (if(planFeatures) real, no siempre-verdadero)', async () => {
                const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

                vi.spyOn(supabaseAdmin, 'rpc').mockImplementation((fnName: string, ...args: any[]) => {
                    if (fnName === 'organization_enabled_features') {
                        return Promise.resolve({ data: null, error: { message: 'Simulated RPC failure' } }) as any;
                    }
                    return originalRpc(fnName, ...args);
                });
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    if (table === 'plan_features') {
                        return {
                            select: () => ({
                                // Dos .eq() encadenados (plan_key, luego enabled) —
                                // el segundo es el que finalmente falla.
                                eq: () => ({
                                    eq: () => Promise.resolve({ data: null, error: { message: 'Simulated plan_features failure' } }),
                                }),
                            }),
                        } as any;
                    }
                    return originalFrom(table);
                });

                clearEntitlementsCache(REAL_ORG_ID);
                const features = await getOrganizationFeatures(REAL_ORG_ID);
                // Sin lanzar excepción, y sin ninguna feature del plan (data null).
                expect(features instanceof Set).toBe(true);

                vi.restoreAllMocks();
                clearEntitlementsCache();
            });

            it('el override respeta el límite estrictamente ("<", no "<="): un expires_at exactamente igual a "ahora" todavía es válido', async () => {
                // Se mockea organization_features en vez de escribir el valor
                // real en la base: un round-trip por Postgres puede reformatear
                // el timestamp (precisión, offset "+00:00" vs "Z") y romper la
                // igualdad exacta que esta prueba necesita para el límite.
                const fixedIso = '2026-06-15T12:00:00.000Z';
                vi.useFakeTimers({ toFake: ['Date'] });
                vi.setSystemTime(new Date(fixedIso));

                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

                vi.spyOn(supabaseAdmin, 'rpc').mockImplementation((fnName: string, ...args: any[]) => {
                    if (fnName === 'organization_enabled_features') {
                        return Promise.resolve({ data: null, error: { message: 'Simulated RPC failure' } }) as any;
                    }
                    return originalRpc(fnName, ...args);
                });
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    if (table === 'organization_features') {
                        return {
                            select: () => ({
                                eq: () =>
                                    Promise.resolve({
                                        data: [{ feature_key: 'sms_agent', enabled: true, expires_at: fixedIso }],
                                        error: null,
                                    }),
                            }),
                        } as any;
                    }
                    return originalFrom(table);
                });

                clearEntitlementsCache(REAL_ORG_ID);

                try {
                    const features = await getOrganizationFeatures(REAL_ORG_ID);
                    expect(features.has('sms_agent')).toBe(true);
                } finally {
                    vi.useRealTimers();
                    vi.restoreAllMocks();
                    clearEntitlementsCache();
                }
            });

            it('contraparte de rechazo: un override con expires_at en el pasado se salta en el fallback JS (no se agrega)', async () => {
                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

                vi.spyOn(supabaseAdmin, 'rpc').mockImplementation((fnName: string, ...args: any[]) => {
                    if (fnName === 'organization_enabled_features') {
                        return Promise.resolve({ data: null, error: { message: 'Simulated RPC failure' } }) as any;
                    }
                    return originalRpc(fnName, ...args);
                });
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    if (table === 'organization_features') {
                        return {
                            select: () => ({
                                eq: () =>
                                    Promise.resolve({
                                        data: [{ feature_key: 'sms_agent', enabled: true, expires_at: '2020-01-01T00:00:00.000Z' }],
                                        error: null,
                                    }),
                            }),
                        } as any;
                    }
                    return originalFrom(table);
                });

                clearEntitlementsCache(REAL_ORG_ID);

                try {
                    const features = await getOrganizationFeatures(REAL_ORG_ID);
                    expect(features.has('sms_agent')).toBe(false);
                } finally {
                    vi.restoreAllMocks();
                    clearEntitlementsCache();
                }
            });

            it('getOrganizationFeatures (fallback JS) también cachea su resultado, no solo el camino del RPC exitoso', async () => {
                const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'rpc').mockImplementation((fnName: string, ...args: any[]) => {
                    if (fnName === 'organization_enabled_features') {
                        return Promise.resolve({ data: null, error: { message: 'Simulated RPC failure' } }) as any;
                    }
                    return originalRpc(fnName, ...args);
                });

                const orgSelectArgs: unknown[] = [];
                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                const fromSpy = vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    const real = originalFrom(table);
                    if (table === 'organizations') return traceQueryArgs(real, orgSelectArgs, []);
                    return real;
                });

                clearEntitlementsCache(REAL_ORG_ID);
                await getOrganizationFeatures(REAL_ORG_ID);
                await getOrganizationFeatures(REAL_ORG_ID);

                // La consulta a `organizations` (parte del fallback) solo debió
                // ocurrir en la primera llamada — la segunda debió servirse de caché.
                expect(orgSelectArgs.length).toBe(1);

                fromSpy.mockRestore();
                vi.restoreAllMocks();
                clearEntitlementsCache();
            });

            it('checkProviderCredentials resuelve el secretKey exacto por proveedor (elevenlabs, telnyx, cal, meta), sin fall-through entre casos', async () => {
                const getSecretSpy = vi.spyOn(secretService, 'getSecret').mockResolvedValue('valid-secret');

                await checkProviderCredentials(REAL_ORG_ID, 'voice_inbound'); // requires_provider: elevenlabs
                expect(getSecretSpy).toHaveBeenLastCalledWith(REAL_ORG_ID, SECRET_KEYS.ELEVENLABS_API_KEY);

                await checkProviderCredentials(REAL_ORG_ID, 'voice_outbound'); // requires_provider: telnyx
                expect(getSecretSpy).toHaveBeenLastCalledWith(REAL_ORG_ID, SECRET_KEYS.TELNYX_API_KEY);

                await checkProviderCredentials(REAL_ORG_ID, 'calendar_booking'); // requires_provider: cal
                expect(getSecretSpy).toHaveBeenLastCalledWith(REAL_ORG_ID, SECRET_KEYS.CAL_API_KEY);

                await checkProviderCredentials(REAL_ORG_ID, 'whatsapp'); // requires_provider: meta
                expect(getSecretSpy).toHaveBeenLastCalledWith(REAL_ORG_ID, SECRET_KEYS.WHATSAPP_ACCESS_TOKEN);
            });

            it('checkProviderCredentials responde ok:true si requires_provider no coincide con ningún proveedor soportado', async () => {
                // La base real restringe requires_provider a
                // {elevenlabs,telnyx,meta,cal} vía CHECK constraint — no se
                // puede sembrar un valor fuera de ese conjunto con datos
                // reales, así que se simula la fila.
                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    if (table === 'features') {
                        return {
                            select: () => ({
                                eq: () => ({
                                    maybeSingle: () =>
                                        Promise.resolve({ data: { requires_provider: 'unknown_provider_xyz' }, error: null }),
                                }),
                            }),
                        } as any;
                    }
                    return originalFrom(table);
                });

                try {
                    const res = await checkProviderCredentials(REAL_ORG_ID, 'feature_cualquiera');
                    expect(res.ok).toBe(true);
                } finally {
                    vi.restoreAllMocks();
                }
            });

            it('checkProviderCredentials consulta exactamente la columna requires_provider', async () => {
                const selectArgs: unknown[] = [];
                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    const real = originalFrom(table);
                    if (table === 'features') return traceQueryArgs(real, selectArgs, []);
                    return real;
                });

                await checkProviderCredentials(REAL_ORG_ID, 'whatsapp');

                expect(selectArgs).toContain('requires_provider');
                vi.restoreAllMocks();
            });

            it('setFeatureOverride recorta espacios del reason antes de guardarlo, tanto en la bitácora como en la propia fila de override', async () => {
                const testFeature = 'call_recording';
                const uniqueReason = `  Reason con espacios ${Date.now()}  `;

                const res = await setFeatureOverride(REAL_ORG_ID, testFeature, false, uniqueReason);
                expect(res.success).toBe(true);

                try {
                    const { data: overrideRow } = await supabaseAdmin
                        .from('organization_features')
                        .select('reason')
                        .eq('organization_id', REAL_ORG_ID)
                        .eq('feature_key', testFeature)
                        .single();
                    expect(overrideRow?.reason).toBe(uniqueReason.trim());

                    const logs = await getFeatureAuditLog(REAL_ORG_ID);
                    const entry = logs.find((l: any) => l.reason?.trim() === uniqueReason.trim());
                    expect(entry).toBeDefined();
                    expect(entry.reason).toBe(uniqueReason.trim());
                } finally {
                    await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', testFeature);
                    clearEntitlementsCache();
                }
            });

            it('setFeatureOverride marca agent_reprovision_pending=true en la fila real de la organización', async () => {
                const testFeature = 'call_recording';
                await supabaseAdmin.from('organizations').update({ agent_reprovision_pending: false }).eq('id', REAL_ORG_ID);

                // reprovisionAgent() real limpia esta misma marca al terminar
                // (ver comentario en el código fuente) — se mockea como no-op
                // para poder observar el estado intermedio que deja
                // setFeatureOverride antes de esa limpieza.
                const agentProv = await import('../src/services/agent-provisioning.js');
                vi.spyOn(agentProv, 'reprovisionAgent').mockResolvedValue(undefined as any);

                const res = await setFeatureOverride(REAL_ORG_ID, testFeature, false, 'Test marca de reprovisión');
                expect(res.success).toBe(true);

                try {
                    const { data: org } = await supabaseAdmin
                        .from('organizations')
                        .select('agent_reprovision_pending')
                        .eq('id', REAL_ORG_ID)
                        .single();
                    expect(org?.agent_reprovision_pending).toBe(true);
                } finally {
                    vi.restoreAllMocks();
                    await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', testFeature);
                    clearEntitlementsCache();
                }
            });

            it('setFeatureOverride: si el UPDATE de agent_reprovision_pending NO falla, no se registra ninguna advertencia (if real, no siempre-verdadero)', async () => {
                const testFeature = 'call_recording';
                const agentProv = await import('../src/services/agent-provisioning.js');
                vi.spyOn(agentProv, 'reprovisionAgent').mockResolvedValue(undefined as any);
                const warnSpy = vi.spyOn(logger, 'warn');

                try {
                    const res = await setFeatureOverride(REAL_ORG_ID, testFeature, false, 'Test sin fallo de marca de reprovisión');
                    expect(res.success).toBe(true);
                    expect(warnSpy).not.toHaveBeenCalledWith(
                        expect.anything(),
                        '[Entitlements] No se pudo marcar agent_reprovision_pending'
                    );
                } finally {
                    vi.restoreAllMocks();
                    await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', testFeature);
                    clearEntitlementsCache();
                }
            });

            it('setFeatureOverride: si falla el UPDATE de agent_reprovision_pending, el override sigue exitoso y se registra una advertencia', async () => {
                const testFeature = 'call_recording';
                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    if (table === 'organizations') {
                        return {
                            update: () => ({
                                eq: () => Promise.resolve({ data: null, error: { message: 'Simulated reprovision flag update error' } }),
                            }),
                        } as any;
                    }
                    return originalFrom(table);
                });
                const warnSpy = vi.spyOn(logger, 'warn');

                try {
                    const res = await setFeatureOverride(REAL_ORG_ID, testFeature, false, 'Test fallo de marca de reprovisión');
                    expect(res.success).toBe(true);
                    expect(warnSpy).toHaveBeenCalledWith(
                        expect.objectContaining({ organizationId: REAL_ORG_ID }),
                        '[Entitlements] No se pudo marcar agent_reprovision_pending'
                    );
                } finally {
                    vi.restoreAllMocks();
                    await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', testFeature);
                    clearEntitlementsCache();
                }
            });

            it('setFeatureOverride: excepción al reprovisionar el agente se registra con el mensaje exacto (no solo se ignora)', async () => {
                const agentProv = await import('../src/services/agent-provisioning.js');
                const provError = new Error('Provider API down (test dedicado)');
                vi.spyOn(agentProv, 'reprovisionAgent').mockRejectedValue(provError);
                const warnSpy = vi.spyOn(logger, 'warn');

                const res = await setFeatureOverride(REAL_ORG_ID, 'call_recording', false, 'Test log de excepción de reprovisión');
                expect(res.success).toBe(true);
                expect(warnSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ err: provError, organizationId: REAL_ORG_ID }),
                    '[Entitlements] Advertencia al reprovisionar agente'
                );

                await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', 'call_recording');
            });

            it('setOrganizationPlan: excepción al reprovisionar el agente se registra con el mensaje exacto', async () => {
                const agentProv = await import('../src/services/agent-provisioning.js');
                const provError = new Error('Provider API error (test dedicado)');
                vi.spyOn(agentProv, 'reprovisionAgent').mockRejectedValue(provError);
                const warnSpy = vi.spyOn(logger, 'warn');

                try {
                    const res = await setOrganizationPlan(REAL_ORG_ID, 'pro', 'Test log de excepción de reprovisión tras cambio de plan');
                    expect(res.success).toBe(true);
                    expect(warnSpy).toHaveBeenCalledWith(
                        expect.objectContaining({ err: provError, organizationId: REAL_ORG_ID }),
                        '[Entitlements] Advertencia al reprovisionar agente tras cambio de plan'
                    );
                } finally {
                    await supabaseAdmin.from('organizations').update({ plan_key: 'starter', max_concurrent_calls: 1 }).eq('id', REAL_ORG_ID);
                    clearEntitlementsCache();
                }
            });

            it('setOrganizationPlan: si falla la inserción de auditoría, se registra el error con el mensaje exacto', async () => {
                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                const auditError = { message: 'Simulated audit log insert failure (test dedicado)' };
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    if (table === 'feature_audit_log') {
                        return {
                            insert: () => Promise.resolve({ data: null, error: auditError }),
                        } as any;
                    }
                    return originalFrom(table);
                });
                const errorSpy = vi.spyOn(logger, 'error');

                try {
                    const res = await setOrganizationPlan(REAL_ORG_ID, 'pro', 'Test log de error de auditoría de plan');
                    expect(res.success).toBe(true);
                    expect(errorSpy).toHaveBeenCalledWith(
                        expect.objectContaining({ err: auditError, organizationId: REAL_ORG_ID, planKey: 'pro' }),
                        '[Entitlements] Error registrando auditoría de cambio de plan'
                    );
                } finally {
                    await supabaseAdmin.from('organizations').update({ plan_key: 'starter', max_concurrent_calls: 1 }).eq('id', REAL_ORG_ID);
                }
            });

            it('setOrganizationPlan guarda el feature_key exacto "plan:<key>" y el reason recortado en la bitácora de auditoría', async () => {
                const uniqueReason = `  Cambio de plan verificable ${Date.now()}  `;
                try {
                    const res = await setOrganizationPlan(REAL_ORG_ID, 'pro', uniqueReason);
                    expect(res.success).toBe(true);

                    const logs = await getFeatureAuditLog(REAL_ORG_ID);
                    const entry = logs.find((l: any) => l.reason === uniqueReason.trim());
                    expect(entry).toBeDefined();
                    expect(entry.feature_key).toBe('plan:pro');
                    expect(entry.reason).toBe(uniqueReason.trim());
                } finally {
                    await supabaseAdmin.from('organizations').update({ plan_key: 'starter', max_concurrent_calls: 1 }).eq('id', REAL_ORG_ID);
                    clearEntitlementsCache();
                }
            });

            it('setOrganizationPlan marca agent_reprovision_pending=true en la fila real de la organización', async () => {
                await supabaseAdmin.from('organizations').update({ agent_reprovision_pending: false }).eq('id', REAL_ORG_ID);

                const agentProv = await import('../src/services/agent-provisioning.js');
                vi.spyOn(agentProv, 'reprovisionAgent').mockResolvedValue(undefined as any);

                try {
                    const res = await setOrganizationPlan(REAL_ORG_ID, 'pro', 'Test marca de reprovisión por cambio de plan');
                    expect(res.success).toBe(true);

                    const { data: org } = await supabaseAdmin
                        .from('organizations')
                        .select('agent_reprovision_pending')
                        .eq('id', REAL_ORG_ID)
                        .single();
                    expect(org?.agent_reprovision_pending).toBe(true);
                } finally {
                    vi.restoreAllMocks();
                    await supabaseAdmin.from('organizations').update({ plan_key: 'starter', max_concurrent_calls: 1 }).eq('id', REAL_ORG_ID);
                    clearEntitlementsCache();
                }
            });

            it('setFeatureOverride revierte por organización Y feature exactos, no un DELETE sin filtro (aislamiento entre features)', async () => {
                // Sembrar una feature "testigo" que NO debe verse afectada por
                // el revert de otra feature con auditoría fallida.
                const witnessFeature = 'call_recording';
                const failingFeature = 'sms_agent';

                await supabaseAdmin.from('organization_features').upsert(
                    {
                        organization_id: REAL_ORG_ID,
                        feature_key: witnessFeature,
                        enabled: true,
                        reason: 'Testigo que no debe borrarse',
                    },
                    { onConflict: 'organization_id,feature_key' }
                );

                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    if (table === 'feature_audit_log') {
                        return {
                            insert: () => Promise.resolve({ data: null, error: { message: 'Simulated audit failure (aislamiento)' } }),
                        } as any;
                    }
                    return originalFrom(table);
                });

                try {
                    const res = await setFeatureOverride(REAL_ORG_ID, failingFeature, true, 'Test aislamiento de revert');
                    expect(res.success).toBe(false);

                    vi.restoreAllMocks();

                    const { data: witnessRow } = await supabaseAdmin
                        .from('organization_features')
                        .select('feature_key')
                        .eq('organization_id', REAL_ORG_ID)
                        .eq('feature_key', witnessFeature)
                        .maybeSingle();
                    expect(witnessRow).not.toBeNull();

                    const { data: failingRow } = await supabaseAdmin
                        .from('organization_features')
                        .select('feature_key')
                        .eq('organization_id', REAL_ORG_ID)
                        .eq('feature_key', failingFeature)
                        .maybeSingle();
                    expect(failingRow).toBeNull();
                } finally {
                    vi.restoreAllMocks();
                    await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', witnessFeature);
                    await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', failingFeature);
                    clearEntitlementsCache();
                }
            });

            it('setFeatureOverride revierte SOLO la organización que falló, no la misma feature en OTRA organización (aislamiento cross-tenant del revert)', async () => {
                const sharedFeature = 'sms_agent';
                const { data: otherOrg, error: otherOrgErr } = await supabaseAdmin
                    .from('organizations')
                    .insert({ name: 'Org Pruebas revert aislamiento', email: `test-revert-isolation-${Date.now()}@example.invalid` })
                    .select('id')
                    .single();
                if (otherOrgErr || !otherOrg) throw new Error(`No se pudo crear la organización testigo: ${otherOrgErr?.message}`);
                const otherOrgId = otherOrg.id as string;

                await supabaseAdmin.from('organization_features').upsert(
                    {
                        organization_id: otherOrgId,
                        feature_key: sharedFeature,
                        enabled: true,
                        reason: 'Testigo cross-tenant que no debe borrarse',
                    },
                    { onConflict: 'organization_id,feature_key' }
                );

                const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
                vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
                    if (table === 'feature_audit_log') {
                        return {
                            insert: () => Promise.resolve({ data: null, error: { message: 'Simulated audit failure (cross-tenant)' } }),
                        } as any;
                    }
                    return originalFrom(table);
                });

                try {
                    const res = await setFeatureOverride(REAL_ORG_ID, sharedFeature, true, 'Test aislamiento cross-tenant de revert');
                    expect(res.success).toBe(false);

                    vi.restoreAllMocks();

                    const { data: otherOrgRow } = await supabaseAdmin
                        .from('organization_features')
                        .select('feature_key')
                        .eq('organization_id', otherOrgId)
                        .eq('feature_key', sharedFeature)
                        .maybeSingle();
                    expect(otherOrgRow).not.toBeNull();
                } finally {
                    vi.restoreAllMocks();
                    await supabaseAdmin.from('organization_features').delete().eq('organization_id', REAL_ORG_ID).eq('feature_key', sharedFeature);
                    await supabaseAdmin.from('organization_features').delete().eq('organization_id', otherOrgId).eq('feature_key', sharedFeature);
                    await supabaseAdmin.from('organizations').delete().eq('id', otherOrgId);
                    clearEntitlementsCache();
                }
            });
        });
    });
});
