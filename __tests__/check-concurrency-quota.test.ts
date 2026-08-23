import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import {
    checkConcurrencyQuotaHandler,
    checkConcurrencyQuotaSweepHandler,
    type CheckConcurrencyQuotaJobData,
} from '../src/jobs/check-concurrency-quota.js';

/**
 * Mismo criterio que check-elevenlabs-credits.test.ts: Vault real para el
 * secreto, pero la red saliente a api.elevenlabs.io se mockea — la lista de
 * conversaciones activas es un contrato NO verificado contra la API real
 * (decisión explícita del usuario, docs/tasks/catalogo-productos-grupos-cred.md
 * FASE B.4), así que la prueba fija la forma asumida de la respuesta.
 */
const realFetch = global.fetch;

function mockConversationsList(agentIdToStatuses: Record<string, string[]>) {
    return vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('https://api.elevenlabs.io/')) {
            const conversations = Object.entries(agentIdToStatuses).flatMap(([agentId, statuses]) =>
                statuses.map((status) => ({ agent_id: agentId, status }))
            );
            return new Response(JSON.stringify({ conversations, has_more: false, next_cursor: null }), { status: 200 });
        }
        return realFetch(input as any, init);
    });
}

function buildFakeFastify(): FastifyInstance {
    return {
        supabaseAdmin,
        log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    } as unknown as FastifyInstance;
}

function buildJob(data: CheckConcurrencyQuotaJobData): Job<CheckConcurrencyQuotaJobData> {
    return { id: 'fake-job-id', data } as unknown as Job<CheckConcurrencyQuotaJobData>;
}

describe('src/jobs/check-concurrency-quota.ts', () => {
    let groupId: string;
    let ownerOrgId: string;
    let memberOrgId: string;
    const OWNER_AGENT_ID = `agent-owner-ccq-${Date.now()}`;
    const MEMBER_AGENT_ID = `agent-member-ccq-${Date.now()}`;
    const API_KEY_VALUE = 'sk_test_fake_elevenlabs_key_ccq';

    beforeAll(async () => {
        const { data: group, error: groupErr } = await supabaseAdmin
            .from('credential_groups')
            .insert({ name: 'Grupo (check-concurrency-quota.test.ts)' })
            .select('id')
            .single();
        if (groupErr || !group) throw new Error(`No se pudo crear el grupo: ${groupErr?.message}`);
        groupId = group.id;

        const { data: owner, error: ownerErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Owner (check-concurrency-quota.test.ts)',
                email: `owner-ccq-test-${Date.now()}@example.invalid`,
                credential_group_id: groupId,
                elevenlabs_agent_id: OWNER_AGENT_ID,
            })
            .select('id')
            .single();
        if (ownerErr || !owner) throw new Error(`No se pudo crear owner: ${ownerErr?.message}`);
        ownerOrgId = owner.id;

        await supabaseAdmin.from('credential_groups').update({ owner_organization_id: ownerOrgId }).eq('id', groupId);

        const { data: member, error: memberErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Miembro (check-concurrency-quota.test.ts)',
                email: `member-ccq-test-${Date.now()}@example.invalid`,
                credential_group_id: groupId,
                elevenlabs_agent_id: MEMBER_AGENT_ID,
            })
            .select('id')
            .single();
        if (memberErr || !member) throw new Error(`No se pudo crear member: ${memberErr?.message}`);
        memberOrgId = member.id;

        const saved = await setSecret(ownerOrgId, SECRET_KEYS.ELEVENLABS_API_KEY, API_KEY_VALUE);
        if (!saved) throw new Error('No se pudo guardar la credencial de prueba');
        clearSecretCache(ownerOrgId);

        await supabaseAdmin.from('organization_concurrency_quota').insert([
            { organization_id: ownerOrgId, soft_limit: 5 },
            { organization_id: memberOrgId, soft_limit: 1 },
        ]);
    });

    afterAll(async () => {
        await supabaseAdmin.from('concurrency_quota_alerts').delete().eq('credential_group_id', groupId);
        await supabaseAdmin.from('organization_concurrency_quota').delete().in('organization_id', [ownerOrgId, memberOrgId]);
        await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', ownerOrgId);
        await supabaseAdmin.from('organizations').delete().eq('id', memberOrgId);
        await supabaseAdmin.from('organizations').delete().eq('id', ownerOrgId);
        await supabaseAdmin.from('credential_groups').delete().eq('id', groupId);
        vi.restoreAllMocks();
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await supabaseAdmin.from('concurrency_quota_alerts').delete().eq('credential_group_id', groupId);
    });

    it('organización que rebasa su cuota blanda genera un aviso en concurrency_quota_alerts, sin rechazar nada', async () => {
        mockConversationsList({ [MEMBER_AGENT_ID]: ['in-progress', 'in-progress'] }); // 2 > soft_limit=1
        const fastify = buildFakeFastify();

        await checkConcurrencyQuotaHandler(fastify, buildJob({ credentialGroupId: groupId, ownerOrganizationId: ownerOrgId }));

        const { data: alerts } = await supabaseAdmin
            .from('concurrency_quota_alerts')
            .select('organization_id, current_count, soft_limit')
            .eq('organization_id', memberOrgId);

        expect(alerts?.length).toBe(1);
        expect(alerts?.[0].current_count).toBe(2);
        expect(alerts?.[0].soft_limit).toBe(1);
        expect(fastify.log.warn).toHaveBeenCalled();
    });

    it('contraparte: organización dentro de su cuota blanda NO genera ningún aviso', async () => {
        mockConversationsList({ [OWNER_AGENT_ID]: ['in-progress'] }); // 1 <= soft_limit=5
        const fastify = buildFakeFastify();

        await checkConcurrencyQuotaHandler(fastify, buildJob({ credentialGroupId: groupId, ownerOrganizationId: ownerOrgId }));

        const { data: alerts } = await supabaseAdmin
            .from('concurrency_quota_alerts')
            .select('id')
            .eq('organization_id', ownerOrgId);

        expect(alerts?.length ?? 0).toBe(0);
    });

    it('estados que no son activos ("done", "failed") no cuentan para la concurrencia', async () => {
        mockConversationsList({ [MEMBER_AGENT_ID]: ['done', 'failed', 'done'] });
        const fastify = buildFakeFastify();

        await checkConcurrencyQuotaHandler(fastify, buildJob({ credentialGroupId: groupId, ownerOrganizationId: ownerOrgId }));

        const { data: alerts } = await supabaseAdmin
            .from('concurrency_quota_alerts')
            .select('id')
            .eq('organization_id', memberOrgId);

        expect(alerts?.length ?? 0).toBe(0);
    });

    it('dedup: un segundo rebase el mismo día no genera un segundo aviso', async () => {
        mockConversationsList({ [MEMBER_AGENT_ID]: ['in-progress', 'in-progress'] });
        const fastify = buildFakeFastify();

        await checkConcurrencyQuotaHandler(fastify, buildJob({ credentialGroupId: groupId, ownerOrganizationId: ownerOrgId }));
        await checkConcurrencyQuotaHandler(fastify, buildJob({ credentialGroupId: groupId, ownerOrganizationId: ownerOrgId }));

        const { data: alerts } = await supabaseAdmin
            .from('concurrency_quota_alerts')
            .select('id')
            .eq('organization_id', memberOrgId);

        expect(alerts?.length).toBe(1);
    });

    it('sin credencial de ElevenLabs para el grupo, se omite sin lanzar', async () => {
        mockConversationsList({});
        const fastify = buildFakeFastify();

        await expect(
            checkConcurrencyQuotaHandler(fastify, buildJob({ credentialGroupId: 'grupo-sin-credencial', ownerOrganizationId: '00000000-0000-0000-0000-000000000000' }))
        ).resolves.not.toThrow();
    });

    describe('checkConcurrencyQuotaSweepHandler', () => {
        it('encola un chequeo por cada grupo con owner_organization_id resuelto', async () => {
            const sendSpy = vi.fn().mockResolvedValue('fake-job-id');
            const fastify = { ...buildFakeFastify(), pgBoss: { send: sendSpy } } as unknown as FastifyInstance;

            await checkConcurrencyQuotaSweepHandler(fastify);

            const calledWithThisGroup = sendSpy.mock.calls.some(
                (call) => call[1]?.credentialGroupId === groupId && call[1]?.ownerOrganizationId === ownerOrgId
            );
            expect(calledWithThisGroup).toBe(true);
        });
    });
});
