import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * Pruebas de la lógica SQL de db/migrations/36_weekly_reports.sql contra la
 * base real — requiere que la migración 36 ya esté aplicada.
 */
describe('db/migrations/36_weekly_reports.sql — funciones y vistas', () => {
    let orgId: string;

    beforeAll(async () => {
        const { data: org, error } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Test Org (weekly-reports-sql.test.ts)',
                email: `test-weekly-reports-sql-${crypto.randomUUID()}@example.invalid`,
                timezone: 'America/Mexico_City',
            })
            .select('id')
            .single();
        if (error || !org) {
            throw new Error(`No se pudo crear la organización dedicada de la prueba: ${error?.message}`);
        }
        orgId = org.id;
    });

    afterAll(async () => {
        if (orgId) {
            await supabaseAdmin.from('weekly_reports').delete().eq('organization_id', orgId);
            await supabaseAdmin.from('organizations').delete().eq('id', orgId);
        }
    });

    describe('organizations_due_for_report', () => {
        it('dispara para una hora local arbitraria (no múltiplo de 6h), no solo para offsets exactos', async () => {
            // America/Mexico_City = UTC-6 (sin horario de verano desde 2022).
            // Configuramos "hoy" (cualquier día de la semana) a la hora local
            // actual, y llamamos a organizations_due_for_report con `p_now`
            // fijado exactamente a ese instante — debe caer justo en el borde
            // superior de la ventana (ahora_local - 6h, ahora_local].
            const now = new Date();
            const localNow = new Date(now.getTime() - 6 * 60 * 60 * 1000); // aproximación de la hora local (UTC-6)
            const dayOfWeek = localNow.getUTCDay();
            const hour = localNow.getUTCHours();

            await supabaseAdmin
                .from('organizations')
                .update({
                    integration_settings: {
                        reports: { planning: { enabled: true, dayOfWeek, hour, channels: ['email'] } },
                    },
                })
                .eq('id', orgId);

            const { data, error } = await supabaseAdmin.rpc('organizations_due_for_report', {
                p_report_type: 'planning',
                p_sweep_interval: '6 hours',
                p_now: now.toISOString(),
            });

            expect(error).toBeNull();
            const orgIds = (data ?? []).map((r: { organization_id: string }) => r.organization_id);
            expect(orgIds).toContain(orgId);
        });

        it('no dispara fuera de la ventana configurada', async () => {
            const now = new Date();
            // Un día/hora que definitivamente no cae en la ventana de 6h que
            // termina "ahora": lo desplazamos 3 días.
            const farDay = (now.getUTCDay() + 3) % 7;

            await supabaseAdmin
                .from('organizations')
                .update({
                    integration_settings: {
                        reports: { planning: { enabled: true, dayOfWeek: farDay, hour: now.getUTCHours(), channels: ['email'] } },
                    },
                })
                .eq('id', orgId);

            const { data, error } = await supabaseAdmin.rpc('organizations_due_for_report', {
                p_report_type: 'planning',
                p_sweep_interval: '6 hours',
                p_now: now.toISOString(),
            });

            expect(error).toBeNull();
            const orgIds = (data ?? []).map((r: { organization_id: string }) => r.organization_id);
            expect(orgIds).not.toContain(orgId);
        });

        it('no dispara dos veces para la misma semana (respeta el UNIQUE de weekly_reports)', async () => {
            const now = new Date();
            const localNow = new Date(now.getTime() - 6 * 60 * 60 * 1000);
            const dayOfWeek = localNow.getUTCDay();
            const hour = localNow.getUTCHours();

            await supabaseAdmin
                .from('organizations')
                .update({
                    integration_settings: {
                        reports: { executive: { enabled: true, dayOfWeek, hour, channels: ['email'] } },
                    },
                })
                .eq('id', orgId);

            const { data: before } = await supabaseAdmin.rpc('organizations_due_for_report', {
                p_report_type: 'executive',
                p_sweep_interval: '6 hours',
                p_now: now.toISOString(),
            });
            const beforeIds = (before ?? []).map((r: { organization_id: string; week_start: string }) => r.organization_id);
            expect(beforeIds).toContain(orgId);
            const weekStart = (before ?? []).find((r: { organization_id: string }) => r.organization_id === orgId)?.week_start;

            await supabaseAdmin.from('weekly_reports').insert({
                organization_id: orgId,
                report_type: 'executive',
                week_start: weekStart,
                status: 'generated',
                data: {},
            });

            const { data: after } = await supabaseAdmin.rpc('organizations_due_for_report', {
                p_report_type: 'executive',
                p_sweep_interval: '6 hours',
                p_now: now.toISOString(),
            });
            const afterIds = (after ?? []).map((r: { organization_id: string }) => r.organization_id);
            expect(afterIds).not.toContain(orgId);
        });
    });

    describe('weekly_reports — idempotencia (B.1)', () => {
        it('el UNIQUE (organization_id, report_type, week_start) rechaza un segundo reclamo de la misma semana', async () => {
            const weekStart = '2026-01-05';
            const first = await supabaseAdmin
                .from('weekly_reports')
                .insert({ organization_id: orgId, report_type: 'planning', week_start: weekStart, status: 'generating', data: {} });
            expect(first.error).toBeNull();

            const second = await supabaseAdmin
                .from('weekly_reports')
                .insert({ organization_id: orgId, report_type: 'planning', week_start: weekStart, status: 'generating', data: {} });
            expect(second.error?.code).toBe('23505');
        });
    });

    describe('v_hot_leads_pending', () => {
        let contactId: string;
        let leadId: string;

        afterAll(async () => {
            if (leadId) await supabaseAdmin.from('leads').delete().eq('id', leadId);
            if (contactId) await supabaseAdmin.from('contacts').delete().eq('id', contactId);
        });

        it('incluye un lead caliente con followup_status pendiente, y respeta el COALESCE con el contacto', async () => {
            const { data: contact, error: contactErr } = await supabaseAdmin
                .from('contacts')
                .insert({ organization_id: orgId, full_name: 'Contacto Real', phone_e164: '+525500000000' })
                .select('id')
                .single();
            expect(contactErr).toBeNull();
            contactId = contact!.id;

            const { data: lead, error: leadErr } = await supabaseAdmin
                .from('leads')
                .insert({
                    organization_id: orgId,
                    contact_id: contactId,
                    channel: 'voice',
                    conversation_id: `conv-${crypto.randomUUID()}`,
                    temperature: 'caliente',
                    followup_status: 'pendiente',
                    email: null,
                })
                .select('id')
                .single();
            expect(leadErr).toBeNull();
            leadId = lead!.id;

            const { data, error } = await supabaseAdmin
                .from('v_hot_leads_pending')
                .select('lead_id, email, phone_e164')
                .eq('organization_id', orgId)
                .eq('lead_id', leadId)
                .maybeSingle();

            expect(error).toBeNull();
            expect(data).not.toBeNull();
            // El lead no trae email propio — debe caer al del contacto (COALESCE).
            expect(data?.phone_e164).toBe('+525500000000');
        });
    });
});
