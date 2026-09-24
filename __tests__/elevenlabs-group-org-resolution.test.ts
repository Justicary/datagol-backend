import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveGroupOrganization } from '../src/services/elevenlabs-group-org-resolution.js';

/**
 * Pruebas unitarias de la cadena de resolución (sin base de datos). Las de
 * punta a punta por HTTP contra Supabase real viven en
 * __tests__/webhooks-elevenlabs.test.ts.
 */

interface OrgRow {
    id: string;
    status: string;
    credential_group_id: string | null;
}

interface FakeDb {
    organizations: OrgRow[];
    callLogs: Array<{ organization_id: string; provider_call_id: string }>;
    agents: Record<string, string>; // agent_id → organization id
    failOn?: 'agent' | 'call_logs' | 'seeded_org' | 'group';
}

type Filter = [string, unknown];

function buildSupabase(db: FakeDb) {
    const calls: Array<{ table: string; select: string; filters: Filter[]; limit?: number }> = [];

    const client = {
        from(table: string) {
            const call = { table, select: '', filters: [] as Filter[], limit: undefined as number | undefined };
            calls.push(call);
            const fail = (key: FakeDb['failOn']) => (db.failOn === key ? { message: `fallo ${key}` } : null);

            const builder = {
                select(columns: string) {
                    call.select = columns;
                    return builder;
                },
                eq(column: string, value: unknown) {
                    call.filters.push([column, value]);
                    return builder;
                },
                limit(n: number) {
                    call.limit = n;
                    return builder;
                },
                async maybeSingle() {
                    const [column, value] = call.filters[0];
                    if (table === 'organizations' && column === 'elevenlabs_agent_id') {
                        const error = fail('agent');
                        if (error) return { data: null, error };
                        const orgId = db.agents[value as string];
                        return { data: db.organizations.find((o) => o.id === orgId) ?? null, error: null };
                    }
                    if (table === 'organizations' && column === 'id') {
                        const error = fail('seeded_org');
                        if (error) return { data: null, error };
                        return { data: db.organizations.find((o) => o.id === value) ?? null, error: null };
                    }
                    if (table === 'call_logs') {
                        const error = fail('call_logs');
                        if (error) return { data: null, error };
                        const row = db.callLogs.find((c) => c.provider_call_id === value);
                        return { data: row ? { organization_id: row.organization_id } : null, error: null };
                    }
                    throw new Error(`consulta inesperada ${table}.${column}`);
                },
                async returns() {
                    const error = fail('group');
                    if (error) return { data: null, error };
                    const [, groupId] = call.filters[0];
                    const rows = db.organizations.filter((o) => o.credential_group_id === groupId).slice(0, call.limit);
                    return { data: rows, error: null };
                },
            };
            return builder;
        },
    };

    return { supabase: client as unknown as SupabaseClient, calls };
}

const GROUP = 'group-1';
const OWNER: OrgRow = { id: 'org-owner', status: 'active', credential_group_id: GROUP };
const MEMBER: OrgRow = { id: 'org-member', status: 'active', credential_group_id: GROUP };
const OUTSIDE: OrgRow = { id: 'org-outside', status: 'active', credential_group_id: 'otro-grupo' };

function db(overrides: Partial<FakeDb> = {}): FakeDb {
    return {
        organizations: [OWNER, MEMBER, OUTSIDE],
        callLogs: [],
        agents: { 'agent-owner': OWNER.id, 'agent-member': MEMBER.id, 'agent-outside': OUTSIDE.id },
        ...overrides,
    };
}

const BASE = { groupId: GROUP, ownerOrganizationId: OWNER.id, agentId: 'agent-secundario', conversationId: 'conv-1' };

describe('services/elevenlabs-group-org-resolution.ts', () => {
    describe('1. agente principal registrado', () => {
        it('agente de un miembro del grupo → resuelve por agent_id sin consultar call_logs', async () => {
            const { supabase, calls } = buildSupabase(db());
            const result = await resolveGroupOrganization(supabase, { ...BASE, agentId: 'agent-member' });
            expect(result).toEqual({ resolved: true, organization: { id: MEMBER.id, status: 'active' }, via: 'agent_id' });
            expect(calls).toEqual([
                { table: 'organizations', select: 'id, status, credential_group_id', filters: [['elevenlabs_agent_id', 'agent-member']], limit: undefined },
            ]);
        });

        it('agente de una organización de OTRO grupo → rechaza sin probar respaldos, aunque la conversación esté sembrada en el grupo', async () => {
            const { supabase, calls } = buildSupabase(db({ callLogs: [{ organization_id: OWNER.id, provider_call_id: 'conv-1' }] }));
            const result = await resolveGroupOrganization(supabase, { ...BASE, agentId: 'agent-outside' });
            expect(result).toEqual({ resolved: false, reason: 'agent_de_otro_grupo' });
            expect(calls).toHaveLength(1);
        });

        it('error de consulta → error_consulta con el detalle', async () => {
            const { supabase } = buildSupabase(db({ failOn: 'agent' }));
            expect(await resolveGroupOrganization(supabase, BASE)).toEqual({ resolved: false, reason: 'error_consulta', detail: 'fallo agent' });
        });
    });

    describe('2. llamada pre-sembrada en call_logs', () => {
        it('sembrada para el owner → resuelve al owner vía call_log_presembrado', async () => {
            const { supabase, calls } = buildSupabase(db({ callLogs: [{ organization_id: OWNER.id, provider_call_id: 'conv-1' }] }));
            const result = await resolveGroupOrganization(supabase, BASE);
            expect(result).toEqual({ resolved: true, organization: { id: OWNER.id, status: 'active' }, via: 'call_log_presembrado' });
            expect(calls.map((c) => [c.table, c.select, c.filters])).toEqual([
                ['organizations', 'id, status, credential_group_id', [['elevenlabs_agent_id', 'agent-secundario']]],
                ['call_logs', 'organization_id', [['provider_call_id', 'conv-1']]],
                ['organizations', 'id, status, credential_group_id', [['id', OWNER.id]]],
            ]);
        });

        it('sembrada para un miembro → resuelve al miembro (no a la dueña) y conserva su status', async () => {
            const suspended = { ...MEMBER, status: 'suspended' };
            const { supabase } = buildSupabase(
                db({ organizations: [OWNER, suspended, OUTSIDE], callLogs: [{ organization_id: MEMBER.id, provider_call_id: 'conv-1' }] })
            );
            expect(await resolveGroupOrganization(supabase, BASE)).toEqual({
                resolved: true,
                organization: { id: MEMBER.id, status: 'suspended' },
                via: 'call_log_presembrado',
            });
        });

        it('sembrada para una organización FUERA del grupo → rechaza, nunca cae a la dueña', async () => {
            const { supabase, calls } = buildSupabase(
                db({ organizations: [OWNER, OUTSIDE], callLogs: [{ organization_id: OUTSIDE.id, provider_call_id: 'conv-1' }] })
            );
            expect(await resolveGroupOrganization(supabase, BASE)).toEqual({ resolved: false, reason: 'call_log_de_otro_grupo' });
            expect(calls).toHaveLength(3);
        });

        it('sembrada para una organización que ya no existe → rechaza', async () => {
            const { supabase } = buildSupabase(db({ callLogs: [{ organization_id: 'org-borrada', provider_call_id: 'conv-1' }] }));
            expect(await resolveGroupOrganization(supabase, BASE)).toEqual({ resolved: false, reason: 'call_log_de_otro_grupo' });
        });

        it.each([
            ['call_logs', 'fallo call_logs'],
            ['seeded_org', 'fallo seeded_org'],
        ] as const)('error en la consulta %s → error_consulta', async (failOn, detail) => {
            const { supabase } = buildSupabase(db({ failOn, callLogs: [{ organization_id: OWNER.id, provider_call_id: 'conv-1' }] }));
            expect(await resolveGroupOrganization(supabase, BASE)).toEqual({ resolved: false, reason: 'error_consulta', detail });
        });

        it('sin conversation_id no consulta call_logs', async () => {
            const { supabase, calls } = buildSupabase(db({ callLogs: [{ organization_id: OWNER.id, provider_call_id: 'conv-1' }] }));
            await resolveGroupOrganization(supabase, { ...BASE, conversationId: null });
            expect(calls.some((c) => c.table === 'call_logs')).toBe(false);
        });
    });

    describe('3. dueña del grupo solo si es su única organización', () => {
        it('grupo de una sola organización (la dueña) → resuelve vía owner_grupo_unico', async () => {
            const { supabase, calls } = buildSupabase(db({ organizations: [OWNER, OUTSIDE] }));
            const result = await resolveGroupOrganization(supabase, BASE);
            expect(result).toEqual({ resolved: true, organization: { id: OWNER.id, status: 'active' }, via: 'owner_grupo_unico' });
            const groupQuery = calls[calls.length - 1];
            expect(groupQuery).toEqual({
                table: 'organizations',
                select: 'id, status, credential_group_id',
                filters: [['credential_group_id', GROUP]],
                limit: 2,
            });
        });

        it('grupo con varias organizaciones → sin_atribucion (no se asume la dueña)', async () => {
            const { supabase } = buildSupabase(db());
            expect(await resolveGroupOrganization(supabase, BASE)).toEqual({ resolved: false, reason: 'sin_atribucion' });
        });

        it('única organización del grupo que NO es la dueña registrada → sin_atribucion', async () => {
            const { supabase } = buildSupabase(db({ organizations: [MEMBER, OUTSIDE] }));
            expect(await resolveGroupOrganization(supabase, BASE)).toEqual({ resolved: false, reason: 'sin_atribucion' });
        });

        it('grupo vacío → sin_atribucion', async () => {
            const { supabase } = buildSupabase(db({ organizations: [OUTSIDE] }));
            expect(await resolveGroupOrganization(supabase, BASE)).toEqual({ resolved: false, reason: 'sin_atribucion' });
        });

        it('error en la consulta del grupo → error_consulta', async () => {
            const { supabase } = buildSupabase(db({ failOn: 'group' }));
            expect(await resolveGroupOrganization(supabase, BASE)).toEqual({ resolved: false, reason: 'error_consulta', detail: 'fallo group' });
        });
    });
});
