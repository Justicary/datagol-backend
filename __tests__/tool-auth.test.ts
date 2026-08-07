import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { resolveToolOrganization } from '../src/lib/tool-auth.js';

/**
 * Pruebas de integración reales contra Supabase (organizations,
 * organization_secrets/Vault). Usa una organización dedicada y desechable,
 * igual que __tests__/secret-service.test.ts, para no chocar con otros
 * archivos de test que también escriben en organization_secrets.
 */
describe('src/lib/tool-auth.ts — resolveToolOrganization', () => {
    let testOrgId: string;
    const TEST_TOKEN = `tool-auth-test-token-${Date.now()}`;
    const TEST_SECRET = 'tool-secret-value-abc123';

    function buildFakeFastify(): FastifyInstance {
        return { supabaseAdmin } as unknown as FastifyInstance;
    }

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org Pruebas tool-auth', email: 'test-tool-auth@example.invalid', webhook_token: TEST_TOKEN, cal_event_type_id: 12345 })
            .select('id')
            .single();
        if (error || !data) {
            throw new Error(`No se pudo crear la organización dedicada: ${error?.message}`);
        }
        testOrgId = data.id;

        const saved = await setSecret(testOrgId, SECRET_KEYS.TOOL_WEBHOOK_SECRET, TEST_SECRET);
        if (!saved) {
            throw new Error('No se pudo guardar tool_webhook_secret de prueba en Vault');
        }
        clearSecretCache(testOrgId);
    });

    afterAll(async () => {
        clearSecretCache();
        if (testOrgId) {
            await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', testOrgId);
            await supabaseAdmin.from('organizations').delete().eq('id', testOrgId);
        }
    });

    it('rechaza con reason=invalid_token cuando el webhookToken no resuelve a ninguna organización', async () => {
        const result = await resolveToolOrganization(buildFakeFastify(), 'token-inexistente-xyz', TEST_SECRET);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('invalid_token');
            expect(result.message).toBe('Token de herramienta inválido');
        }
    });

    it('rechaza con reason=missing_secret cuando el header x-tool-secret está ausente', async () => {
        const result = await resolveToolOrganization(buildFakeFastify(), TEST_TOKEN, undefined);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('missing_secret');
            expect(result.message).toBe('Secreto de herramienta inválido o ausente');
        }
    });

    it('rechaza con reason=missing_secret cuando el header x-tool-secret no coincide', async () => {
        const result = await resolveToolOrganization(buildFakeFastify(), TEST_TOKEN, 'valor-incorrecto');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('missing_secret');
    });

    it('contraparte de éxito: token y secreto correctos resuelven la organización y su cal_event_type_id', async () => {
        const result = await resolveToolOrganization(buildFakeFastify(), TEST_TOKEN, TEST_SECRET);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.organizationId).toBe(testOrgId);
            expect(result.calEventTypeId).toBe(12345);
        }
    });

    it('organización suspendida + secreto válido → reason=suspended', async () => {
        await supabaseAdmin.from('organizations').update({ status: 'suspended', suspended_reason: 'Prueba tool-auth' }).eq('id', testOrgId);
        try {
            const result = await resolveToolOrganization(buildFakeFastify(), TEST_TOKEN, TEST_SECRET);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.reason).toBe('suspended');
        } finally {
            await supabaseAdmin.from('organizations').update({ status: 'active', suspended_reason: null, suspended_at: null }).eq('id', testOrgId);
        }
    });

    it('organización suspendida + secreto inválido → reason=missing_secret (el secreto se evalúa primero, no se filtra el estado de suspensión a un llamador no autenticado)', async () => {
        await supabaseAdmin.from('organizations').update({ status: 'suspended', suspended_reason: 'Prueba tool-auth' }).eq('id', testOrgId);
        try {
            const result = await resolveToolOrganization(buildFakeFastify(), TEST_TOKEN, 'secreto-incorrecto');
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.reason).toBe('missing_secret');
        } finally {
            await supabaseAdmin.from('organizations').update({ status: 'active', suspended_reason: null, suspended_at: null }).eq('id', testOrgId);
        }
    });

    it('un secreto configurado para OTRA organización no autentica esta, aunque el valor sea igual (aislamiento multi-tenant)', async () => {
        const { data: otherOrg, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org Pruebas tool-auth B', email: 'test-tool-auth-b@example.invalid', webhook_token: `${TEST_TOKEN}-other` })
            .select('id')
            .single();
        if (error || !otherOrg) throw new Error(`No se pudo crear la segunda organización: ${error?.message}`);

        try {
            // La org B no tiene tool_webhook_secret configurado: el mismo valor
            // que sí es válido para la org A no debe autenticarla.
            const result = await resolveToolOrganization(buildFakeFastify(), `${TEST_TOKEN}-other`, TEST_SECRET);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.reason).toBe('missing_secret');
        } finally {
            await supabaseAdmin.from('organizations').delete().eq('id', otherOrg.id);
        }
    });
});
